import mongoose from 'mongoose';
import { logger } from '../utils/logger';

export const connectDB = async (): Promise<void> => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/gilded-noir';

    await mongoose.connect(mongoURI, {
      // Pool de conexiones: evita abrir/cerrar conexión por cada request y
      // evita saturar Mongo cuando suba el tráfico concurrente.
      maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 20,
      minPoolSize: 2,
      // Si Mongo no responde en 5s, falla rápido en vez de colgar el request
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info('Conectado a MongoDB', { poolSize: Number(process.env.MONGO_POOL_SIZE) || 20 });

    mongoose.connection.on('error', (err: Error) => {
      logger.error('Error de conexión MongoDB', { message: err.message });
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('Desconectado de MongoDB, mongoose intentará reconectar automáticamente');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('Reconectado a MongoDB');
    });
  } catch (error) {
    logger.error('Error al conectar a MongoDB', { error });
    process.exit(1);
  }
};

export const disconnectDB = async (): Promise<void> => {
  await mongoose.connection.close();
  logger.info('Conexión a MongoDB cerrada de forma ordenada');
};
