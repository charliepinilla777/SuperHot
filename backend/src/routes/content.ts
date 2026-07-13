import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { Content } from '../models/Content';
import { User } from '../models/User';
import { Subscription } from '../models/Subscription';
import { logger } from '../utils/logger';
import { cache } from '../utils/cache';

const router = Router();

// Middleware que EXIGE autenticación (usado en escritura/likes)
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

// Middleware que intenta identificar al usuario PERO no bloquea si no hay token
// (necesario para saber si está suscrito sin obligar a loguearse para ver el listado)
const optionalAuth = (req: Request & { user?: any }, res: Response, next: any) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    } catch {
      // token inválido/expirado -> seguimos como anónimo, no es un error fatal aquí
    }
  }
  next();
};

// Obtener contenido de una creadora (con paywall real)
router.get('/creator/:creatorId', optionalAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req: Request & { user?: any }, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { creatorId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const viewerId = req.user?.userId as string | undefined;
    const isOwner = viewerId === creatorId;

    // Verificar si el usuario está suscrito (se cachea 30s por par fan/creadora,
    // es info que puede tolerar unos segundos de retraso)
    let isSubscribed = isOwner;
    if (viewerId && !isOwner) {
      isSubscribed = await cache.wrap(
        `sub:${viewerId}:${creatorId}`,
        30,
        async () => {
          const subscription = await Subscription.findOne({
            fanId: viewerId,
            creatorId,
            status: 'active'
          });
          return !!subscription;
        }
      );
    }

    // El listado "crudo" (sin gating) se cachea por creatorId+page porque es
    // igual para todo el mundo; el gating de fileUrl se aplica DESPUÉS del caché,
    // por usuario, así nunca se cachea contenido pago filtrado incorrectamente.
    const cacheKey = `content:${creatorId}:${page}:${limit}`;
    const { content, total } = await cache.wrap(cacheKey, 45, async () => {
      const rawContent = await Content.find({ creatorId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('creatorId', 'username verificationStatus')
        .lean();

      const totalCount = await Content.countDocuments({ creatorId });
      return { content: rawContent, total: totalCount };
    });

    // PAYWALL: solo se expone fileUrl si el post es gratis, o el usuario está
    // suscrito activo, o es la propia creadora. Si no, se oculta la URL real.
    const gatedContent = content.map((item: any) => {
      const unlocked = item.isFree || isSubscribed;
      return {
        ...item,
        fileUrl: unlocked ? item.fileUrl : null,
        locked: !unlocked,
      };
    });

    res.json({
      content: gatedContent,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      isSubscribed
    });

  } catch (error) {
    logger.error('Error al obtener contenido', { error, creatorId: req.params.creatorId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Subir nuevo contenido (solo creadoras verificadas)
router.post('/upload', authenticateToken, [
  body('title').isLength({ min: 1, max: 100 }).trim(),
  body('description').optional().isLength({ max: 1000 }).trim(),
  body('type').isIn(['photo', 'video']),
  body('isFree').isBoolean(),
  body('price').optional().isFloat({ min: 0 }),
  body('tags').optional().isArray()
], async (req: Request & { user?: any }, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user.userId);
    if (!user || user.role !== 'model' || user.verificationStatus !== 'approved') {
      return res.status(403).json({
        error: 'Solo creadoras verificadas pueden subir contenido'
      });
    }

    const { title, description, type, isFree, price, tags } = req.body;

    const content = new Content({
      creatorId: user._id,
      title,
      description,
      type,
      isFree,
      price: isFree ? 0 : price || user.subscriptionPrice,
      tags: tags || []
    });

    await content.save();
    await content.populate('creatorId', 'username');

    // Invalidamos el caché de listado de esta creadora: el nuevo post debe
    // verse de inmediato, no hasta que expire el TTL de 45s
    cache.invalidatePrefix(`content:${user._id}:`);

    logger.info('Contenido subido', { creatorId: user._id.toString(), contentId: content._id, type });

    res.status(201).json({
      message: 'Contenido subido exitosamente',
      content
    });

  } catch (error) {
    logger.error('Error al subir contenido', { error, userId: req.user?.userId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Dar like a contenido
router.post('/:contentId/like', authenticateToken, async (req: Request & { user?: any }, res: Response) => {
  try {
    const { contentId } = req.params;
    const userId = req.user.userId;

    const content = await Content.findById(contentId);
    if (!content) {
      return res.status(404).json({ error: 'Contenido no encontrado' });
    }

    const alreadyLiked = content.likes.some((id) => id.toString() === userId);
    if (alreadyLiked) {
      await Content.findByIdAndUpdate(
        contentId,
        { $pull: { likes: userId } }
      );
    } else {
      content.likes.push(userId);
      await content.save();
    }

    cache.invalidatePrefix(`content:${content.creatorId}:`);

    res.json({
      message: alreadyLiked ? 'Like quitado' : 'Like agregado',
      likesCount: alreadyLiked ? content.likes.length - 1 : content.likes.length
    });

  } catch (error) {
    logger.error('Error en like', { error, contentId: req.params.contentId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

export default router;
