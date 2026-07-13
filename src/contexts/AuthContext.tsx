import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { type User } from '../lib/api';
import { supabase } from '../lib/supabase';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
}

interface AuthContextType extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (userData: { username: string; email: string; password: string }) => Promise<void>;
  logout: () => void;
  updateUser: (userData: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

type AuthAction =
  | { type: 'LOGIN_START' }
  | { type: 'LOGIN_SUCCESS'; payload: { user: User; token: string } }
  | { type: 'LOGIN_FAILURE'; payload: string }
  | { type: 'LOGOUT' }
  | { type: 'UPDATE_USER'; payload: Partial<User> };

const authReducer = (state: AuthState, action: AuthAction): AuthState => {
  switch (action.type) {
    case 'LOGIN_START':
      return { ...state, isLoading: true, error: null };
    case 'LOGIN_SUCCESS':
      return { ...state, user: action.payload.user, token: action.payload.token, isLoading: false, error: null };
    case 'LOGIN_FAILURE':
      return { ...state, user: null, token: null, isLoading: false, error: action.payload };
    case 'LOGOUT':
      return { ...state, user: null, token: null, isLoading: false, error: null };
    case 'UPDATE_USER':
      return { ...state, user: state.user ? { ...state.user, ...action.payload } : null };
    default:
      return state;
  }
};

const initialState: AuthState = {
  user: null,
  token: null,
  isLoading: true,
  error: null
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  useEffect(() => {
    if (!supabase) {
      dispatch({ type: 'LOGIN_FAILURE', payload: 'Supabase no configurado' });
      return;
    }

    // Carga la sesion activa al iniciar
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const user: User = {
          _id: session.user.id,
          username: session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'usuario',
          email: session.user.email || '',
          role: session.user.user_metadata?.role || 'user',
          verificationStatus: 'pending',
          profile: {}
        };
        dispatch({ type: 'LOGIN_SUCCESS', payload: { user, token: session.access_token } });
      } else {
        dispatch({ type: 'LOGOUT' });
      }
    });

    // Escucha cambios de sesion en tiempo real
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        const user: User = {
          _id: session.user.id,
          username: session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'usuario',
          email: session.user.email || '',
          role: session.user.user_metadata?.role || 'user',
          verificationStatus: 'pending',
          profile: {}
        };
        dispatch({ type: 'LOGIN_SUCCESS', payload: { user, token: session.access_token } });
      } else {
        dispatch({ type: 'LOGOUT' });
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = async (email: string, password: string) => {
    if (!supabase) { dispatch({ type: 'LOGIN_FAILURE', payload: 'Supabase no configurado' }); return; }
    dispatch({ type: 'LOGIN_START' });
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) dispatch({ type: 'LOGIN_FAILURE', payload: error.message });
    } catch {
      dispatch({ type: 'LOGIN_FAILURE', payload: 'Error de conexion' });
    }
  };

  const register = async (userData: { username: string; email: string; password: string }) => {
    if (!supabase) { dispatch({ type: 'LOGIN_FAILURE', payload: 'Supabase no configurado' }); return; }
    dispatch({ type: 'LOGIN_START' });
    try {
      const { error } = await supabase.auth.signUp({
        email: userData.email,
        password: userData.password,
        options: { data: { username: userData.username, role: 'user' } }
      });
      if (error) dispatch({ type: 'LOGIN_FAILURE', payload: error.message });
    } catch {
      dispatch({ type: 'LOGIN_FAILURE', payload: 'Error de conexion' });
    }
  };

  const logout = async () => {
    if (supabase) await supabase.auth.signOut();
    dispatch({ type: 'LOGOUT' });
  };

  const updateUser = (userData: Partial<User>) => {
    if (state.user) {
      dispatch({ type: 'UPDATE_USER', payload: userData });
    }
  };

  const value: AuthContextType = { ...state, login, register, logout, updateUser };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
