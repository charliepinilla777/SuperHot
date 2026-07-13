import mongoose, { Schema, Document } from 'mongoose';

// Interfaz para usuario
export interface IUser extends Document {
  username: string;
  email: string;
  password: string;
  role: 'user' | 'model' | 'admin' | 'supervisor';
  verificationStatus: 'pending' | 'approved' | 'rejected';
  profile: {
    bio: string;
    instagram?: string;
    x?: string;
    website?: string;
  };
  subscriptionPrice: number;
  createdAt: Date;
  updatedAt: Date;
}

// Esquema de usuario
const UserSchema = new Schema<IUser>({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['user', 'model', 'admin', 'supervisor'],
    default: 'user'
  },
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  profile: {
    bio: { type: String, maxlength: 500 },
    instagram: { type: String },
    x: { type: String },
    website: { type: String }
  },
  subscriptionPrice: {
    type: Number,
    min: 0,
    default: 9.99
  }
}, {
  timestamps: true,
  // Sin esto los virtuals de abajo no salen al hacer JSON.stringify(user) / res.json(user)
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para mejor rendimiento
UserSchema.index({ username: 1 });
UserSchema.index({ email: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ verificationStatus: 1 });

// Virtuals: no guardan nada en el documento de User, se resuelven con un
// populate() que busca en otra colección por el campo indicado.
// creators.ts y users.ts ya intentaban usar .populate('content') y
// .populate('subscriptions') pero no existían -> el populate no traía nada.
UserSchema.virtual('content', {
  ref: 'Content',
  localField: '_id',
  foreignField: 'creatorId'
});

UserSchema.virtual('subscriptions', {
  ref: 'Subscription',
  localField: '_id',
  foreignField: 'fanId'
});

export const User = mongoose.model<IUser>('User', UserSchema);
