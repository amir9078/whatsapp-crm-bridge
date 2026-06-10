import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';
import { getToken } from './auth';

let socket: Socket | undefined;

/** One shared Socket.IO connection per browser tab; sends the session token (M7). */
export function getSocket(): Socket {
  socket ??= io(API_URL, {
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: getToken() ?? undefined }),
  });
  return socket;
}

/** Drop and rebuild the connection — call after login so the new token is used. */
export function resetSocket(): void {
  socket?.close();
  socket = undefined;
}
