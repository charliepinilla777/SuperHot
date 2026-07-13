import { Router, Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { Content } from '../models/Content';
import { Subscription } from '../models/Subscription';
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

const optionalAuth = (req: Request & { user?: any }, res: Response, next: any) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    } catch {
      // anónimo si el token no es válido
    }
  }
  next();
};

// Listado/búsqueda de creadoras (lo usa la pantalla Explore)
// Es el endpoint de más tráfico de toda la app -> el que más se beneficia de caché.
router.get('/', [
  query('search').optional().isString().trim(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const search = (req.query.search as string || '').trim();
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Cache key incluye búsqueda+paginación; TTL corto porque subscriberCount cambia seguido
    const cacheKey = `creators:list:${search.toLowerCase()}:${page}:${limit}`;

    const result = await cache.wrap(cacheKey, 60, async () => {
      const filter: Record<string, any> = {
        role: 'model',
        verificationStatus: 'approved',
      };

      if (search) {
        filter.$or = [
          { username: { $regex: search, $options: 'i' } },
          { 'profile.bio': { $regex: search, $options: 'i' } },
        ];
      }

      const [creators, total] = await Promise.all([
        User.find(filter)
          .select('username profile subscriptionPrice verificationStatus')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        User.countDocuments(filter),
      ]);

      // subscriberCount por creadora en un solo aggregate (evita N+1 queries)
      const ids = creators.map((c: any) => c._id);
      const counts = await Subscription.aggregate([
        { $match: { creatorId: { $in: ids }, status: 'active' } },
        { $group: { _id: '$creatorId', count: { $sum: 1 } } },
      ]);
      const countMap = new Map(counts.map((c: any) => [c._id.toString(), c.count]));

      const data = creators.map((c: any) => ({
        ...c,
        subscriberCount: countMap.get(c._id.toString()) || 0,
      }));

      return { data, total };
    });

    res.json({
      data: result.data,
      total: result.total,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.ceil(result.total / limit),
      },
    });
  } catch (error) {
    logger.error('Error al listar creadoras', { error });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener perfil de una creadora específica
router.get('/:creatorId', optionalAuth, async (req: Request & { user?: any }, res: Response) => {
  try {
    const { creatorId } = req.params;

    const creator = await cache.wrap(`creators:profile:${creatorId}`, 60, async () => {
      return User.findById(creatorId)
        .select('-password')
        .populate({
          path: 'content',
          options: { sort: { createdAt: -1 }, limit: 6 },
        })
        .lean();
    });

    if (!creator) {
      return res.status(404).json({ error: 'Creadora no encontrada' });
    }

    let isSubscribed = false;
    if (req.user?.userId) {
      isSubscribed = await cache.wrap(
        `sub:${req.user.userId}:${creatorId}`,
        30,
        async () => {
          const subscription = await Subscription.findOne({
            fanId: req.user.userId,
            creatorId,
            status: 'active',
          });
          return !!subscription;
        }
      );
    }

    const subscriberCount = await cache.wrap(
      `creators:subcount:${creatorId}`,
      30,
      () => Subscription.countDocuments({ creatorId, status: 'active' })
    );

    res.json({
      creator: {
        ...creator,
        isSubscribed,
        subscriberCount,
      },
    });
  } catch (error) {
    logger.error('Error al obtener creadora', { error, creatorId: req.params.creatorId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener estadísticas de creadora (solo para la propia creadora)
router.get('/:creatorId/stats', authenticateToken, async (req: Request & { user?: any }, res: Response) => {
  try {
    const { creatorId } = req.params;
    const userId = req.user.userId;

    const user = await User.findById(userId);
    if (!user || (user._id.toString() !== creatorId && user.role !== 'admin')) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const stats = await Promise.all([
      Subscription.countDocuments({ creatorId, status: 'active' }),
      Content.countDocuments({ creatorId }),
      Content.countDocuments({ creatorId, isFree: false }),
      Content.aggregate([
        { $match: { creatorId } },
        { $group: { _id: null, totalLikes: { $sum: { $size: '$likes' } } } },
      ]),
    ]);

    const [subscribers, totalContent, paidContent, likesResult] = stats;
    const totalLikes = likesResult[0]?.totalLikes || 0;
    const estimatedRevenue = subscribers * (user.subscriptionPrice || 9.99);

    res.json({
      stats: {
        subscribers,
        totalContent,
        paidContent,
        totalLikes,
        estimatedRevenue,
        subscriptionPrice: user.subscriptionPrice || 9.99,
      },
    });
  } catch (error) {
    logger.error('Error al obtener estadísticas', { error, creatorId: req.params.creatorId });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

export default router;
