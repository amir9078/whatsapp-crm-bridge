import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | undefined;

/** One shared Socket.IO connection per browser tab. */
export function getSocket(): Socket {
  socket ??= io(API_URL, { transports: ['websocket', 'polling'] });
  return socket;
}
