import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { ChatMessage } from '../models/ChatMessage';
import { Subscription } from '../models/Subscription';
import { logger } from '../utils/logger';
import { containsForbiddenContact } from '../utils/policy';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  userRole?: string;
}

export const setupSocketHandlers = (io: Server) => {
  io.use((socket: AuthenticatedSocket, next: (err?: Error) => void) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Token requerido'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
      socket.userId = (decoded as any).userId;
      socket.userRole = (decoded as any).role;
      next();
    } catch (error) {
      next(new Error('Token inválido'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    logger.info('Usuario conectado por socket', { userId: socket.userId });

    socket.on('join-room', (data: { creatorId: string }) => {
      const { creatorId } = data;

      Subscription.findOne({
        fanId: socket.userId,
        creatorId,
        status: 'active'
      }).then(subscription => {
        if (subscription) {
          socket.join(`creator-${creatorId}`);
          socket.emit('joined-room', { creatorId });
        } else {
          socket.emit('error', { message: 'Necesitas estar suscrito para unirte al chat' });
        }
      }).catch((error) => {
        logger.error('Error al verificar suscripción en join-room', { error, userId: socket.userId, creatorId });
        socket.emit('error', { message: 'Error al unirse a la sala' });
      });
    });

    socket.on('send-message', async (data: {
      creatorId: string;
      content: string;
      type?: 'text' | 'image' | 'video';
      fileUrl?: string;
    }) => {
      const { creatorId, content, type = 'text', fileUrl } = data;

      try {
        // Mismo filtro anti-contacto/escort que en la ruta REST /chat/send.
        // El socket es otra puerta de entrada al mismo dato, tiene que
        // pasar por la misma validación o el filtro del REST no sirve de nada.
        if (type === 'text' && containsForbiddenContact(content)) {
          logger.warn('Mensaje de socket bloqueado por política de contacto', { senderId: socket.userId, creatorId });
          socket.emit('error', { message: 'No se permite compartir teléfonos, WhatsApp/Telegram ni proponer encuentros presenciales.' });
          return;
        }

        const subscription = await Subscription.findOne({
          fanId: socket.userId,
          creatorId,
          status: 'active'
        });

        if (!subscription) {
          socket.emit('error', { message: 'No estás suscrito a esta creadora' });
          return;
        }

        const message = new ChatMessage({
          senderId: socket.userId,
          receiverId: creatorId,
          content,
          type,
          fileUrl
        });

        await message.save();
        await message.populate([
          { path: 'senderId', select: 'username' },
          { path: 'receiverId', select: 'username' }
        ]);

        io.to(`creator-${creatorId}`).emit('new-message', message);
        socket.join(`user-${socket.userId}-${creatorId}`);

      } catch (error) {
        logger.error('Error al enviar mensaje por socket', { error, userId: socket.userId, creatorId });
        socket.emit('error', { message: 'Error al enviar mensaje' });
      }
    });

    socket.on('mark-read', async (data: { creatorId: string }) => {
      try {
        await ChatMessage.updateMany(
          {
            receiverId: socket.userId,
            senderId: data.creatorId,
            isRead: false
          },
          { isRead: true }
        );

        socket.emit('messages-marked-read');
      } catch (error) {
        logger.error('Error al marcar mensajes como leídos', { error, userId: socket.userId });
      }
    });

    socket.on('get-chat-history', async (data: { creatorId: string }) => {
      try {
        const { creatorId } = data;

        const subscription = await Subscription.findOne({
          fanId: socket.userId,
          creatorId,
          status: 'active'
        });

        if (!subscription) {
          socket.emit('error', { message: 'No estás suscrito a esta creadora' });
          return;
        }

        const messages = await ChatMessage.find({
          $or: [
            { senderId: socket.userId, receiverId: creatorId },
            { senderId: creatorId, receiverId: socket.userId }
          ]
        })
        .sort({ createdAt: 1 })
        .limit(50)
        .populate([
          { path: 'senderId', select: 'username' },
          { path: 'receiverId', select: 'username' }
        ]);

        socket.emit('chat-history', messages);

      } catch (error) {
        logger.error('Error al obtener historial de chat', { error, userId: socket.userId });
        socket.emit('error', { message: 'Error al obtener historial de chat' });
      }
    });

    socket.on('disconnect', () => {
      logger.info('Usuario desconectado de socket', { userId: socket.userId });
    });
  });
};
