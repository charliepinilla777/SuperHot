import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import { cache } from '../utils/cache';

const router = Router();

const authenticateToken = (req: Request & { user?: any }, res: Response, next: any) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// Obtener perfil de usuario
router.get('/profile', authenticateToken, async (req: Request & { user?: any }, res: Response) => {
  try {
    const user = await User.findById(req.user.userId)
      .select('-password')
      .populate('subscriptions');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ user });

  } catch (error) {
    logger.error('Error al obtener perfil', { error, userId: req.user?.userId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Actualizar perfil
router.put('/profile', authenticateToken, [
  body('username').optional().isLength({ min: 3, max: 30 }).trim(),
  body('profile.bio').optional().isLength({ max: 500 }).trim(),
  body('profile.instagram').optional().isURL(),
  body('profile.x').optional().isURL(),
  body('profile.website').optional().isURL()
], async (req: Request & { user?: any }, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, profile, subscriptionPrice } = req.body;
    const userId = req.user.userId;

    if (username) {
      const existingUser = await User.findOne({
        username,
        _id: { $ne: userId }
      });
      if (existingUser) {
        return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        ...(username && { username }),
        ...(profile && { profile }),
        ...(subscriptionPrice !== undefined && { subscriptionPrice })
      },
      { new: true }
    ).select('-password');

    // Si cambió el username/bio/precio, el perfil público cacheado en
    // /api/creators/:id quedaría desactualizado hasta 60s -> lo invalidamos ya.
    cache.del(`creators:profile:${userId}`);
    cache.invalidatePrefix('creators:list:');

    logger.info('Perfil actualizado', { userId });

    res.json({
      message: 'Perfil actualizado exitosamente',
      user: updatedUser
    });

  } catch (error) {
    logger.error('Error al actualizar perfil', { error, userId: req.user?.userId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// NOTA: el listado/búsqueda de creadoras vive en GET /api/creators (con caché
// y conteo de suscriptores agregado). Antes existía un duplicado aquí en
// /api/users/creators sin caché — se eliminó para no tener dos fuentes de
// verdad divergentes. Si el frontend lo llamaba, debe apuntar a /api/creators.

export default router;
