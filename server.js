import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, {
  cors: { 
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Improved connection settings
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  upgradeTimeout: 30000, // 30 seconds
  allowEIO3: true, // Allow fallback to older versions
  transports: ['websocket', 'polling'], // Allow both transports
  // Connection state recovery
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
})

// rooms: { [roomId]: { [clientId]: { socketId, lastSeen } } }
const rooms = {}
// pending removals: { [roomId:clientId]: Timeout }
const pendingRemovals = {}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length,
    connections: io.engine.clientsCount
  })
})

io.on('connection', socket => {
  console.log(`Client connected: ${socket.id}`)
  
  // Send acknowledgment immediately
  socket.emit('connected', { socketId: socket.id, timestamp: Date.now() })

  socket.on('join-room', ({ roomId, clientId }, callback) => {
    try {
      const key = `${roomId}:${clientId}`
      
      // Cancel pending removal on reconnect
      if (pendingRemovals[key]) {
        clearTimeout(pendingRemovals[key])
        delete pendingRemovals[key]
        console.log(`Cancelled pending removal for ${key}`)
      }

      // Leave previous room if any
      if (socket.data?.roomId) {
        socket.leave(socket.data.roomId)
      }

      socket.data = { roomId, clientId }
      
      if (!rooms[roomId]) rooms[roomId] = {}
      
      // Store additional info for better tracking
      rooms[roomId][clientId] = {
        socketId: socket.id,
        lastSeen: Date.now(),
        connected: true
      }
      
      socket.join(roomId)

      // Get list of other users in the room
      const otherUsers = Object.keys(rooms[roomId])
        .filter(id => id !== clientId && rooms[roomId][id].connected)
        .map(id => ({
          clientId: id,
          socketId: rooms[roomId][id].socketId
        }))

      console.log(`${clientId} joined room ${roomId}. Users in room: ${Object.keys(rooms[roomId]).length}`)

      // Notify others in the room
      socket.to(roomId).emit('user-joined', { 
        clientId, 
        socketId: socket.id,
        timestamp: Date.now()
      })

      // Send acknowledgment with room info
      if (callback) {
        callback({ 
          success: true, 
          roomId, 
          clientId, 
          otherUsers,
          timestamp: Date.now()
        })
      }
    } catch (error) {
      console.error('Error in join-room:', error)
      if (callback) callback({ success: false, error: error.message })
    }
  })

  // Handle text messages with acknowledgment
  socket.on('send-message', ({ message }, callback) => {
    try {
      const { roomId, clientId } = socket.data || {}
      if (!roomId || !message?.trim()) {
        if (callback) callback({ success: false, error: 'Invalid message or room' })
        return
      }

      const messageData = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        message: message.trim(),
        clientId,
        roomId,
        timestamp: new Date().toISOString()
      }

      // Send message to all users in the room
      io.to(roomId).emit('receive-message', messageData)
      
      console.log(`Message from ${clientId} in ${roomId}: ${message.substring(0, 50)}...`)

      // Send acknowledgment
      if (callback) {
        callback({ 
          success: true, 
          messageId: messageData.id,
          timestamp: messageData.timestamp
        })
      }
    } catch (error) {
      console.error('Error in send-message:', error)
      if (callback) callback({ success: false, error: error.message })
    }
  })

  // WebRTC signaling with better error handling
  socket.on('signal', ({ toClientId, data }, callback) => {
    try {
      const { roomId, clientId } = socket.data || {}
      if (!roomId) {
        if (callback) callback({ success: false, error: 'Not in a room' })
        return
      }

      const toUser = rooms[roomId]?.[toClientId]
      if (toUser && toUser.connected) {
        io.to(toUser.socketId).emit('signal', {
          fromClientId: clientId,
          data
        })
        if (callback) callback({ success: true })
      } else {
        if (callback) callback({ success: false, error: 'Target user not found or offline' })
      }
    } catch (error) {
      console.error('Error in signal:', error)
      if (callback) callback({ success: false, error: error.message })
    }
  })

  // Heartbeat to keep connection alive
  socket.on('heartbeat', (callback) => {
    const { roomId, clientId } = socket.data || {}
    if (roomId && clientId && rooms[roomId]?.[clientId]) {
      rooms[roomId][clientId].lastSeen = Date.now()
    }
    if (callback) callback({ timestamp: Date.now() })
  })

  // Handle connection errors
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error)
  })

  // Handle disconnection with improved cleanup
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`)
    
    const { roomId, clientId } = socket.data || {}
    if (!roomId || !clientId) return

    const key = `${roomId}:${clientId}`

    // Mark as disconnected immediately
    if (rooms[roomId]?.[clientId]) {
      rooms[roomId][clientId].connected = false
      rooms[roomId][clientId].lastSeen = Date.now()
    }

    // Clear any existing pending removal
    if (pendingRemovals[key]) {
      clearTimeout(pendingRemovals[key])
    }

    // Schedule cleanup with different timeouts based on disconnect reason
    const timeout = reason === 'transport close' || reason === 'ping timeout' ? 30000 : 10000

    pendingRemovals[key] = setTimeout(() => {
      try {
        if (rooms[roomId]?.[clientId]) {
          delete rooms[roomId][clientId]
          
          // Notify others in the room
          socket.to(roomId).emit('user-left', { 
            clientId,
            reason: 'timeout',
            timestamp: Date.now()
          })
          
          console.log(`Removed ${clientId} from room ${roomId} after timeout`)
        }

        // Clean up empty room
        if (rooms[roomId] && Object.keys(rooms[roomId]).length === 0) {
          delete rooms[roomId]
          console.log(`Deleted empty room: ${roomId}`)
        }

        delete pendingRemovals[key]
      } catch (error) {
        console.error('Error during cleanup:', error)
      }
    }, timeout)

    console.log(`Scheduled removal for ${key} in ${timeout}ms`)
  })

  // Handle reconnection
  socket.on('reconnect', () => {
    console.log(`Client reconnected: ${socket.id}`)
  })
})

// Periodic cleanup of stale connections
setInterval(() => {
  const now = Date.now()
  const staleThreshold = 5 * 60 * 1000 // 5 minutes

  Object.keys(rooms).forEach(roomId => {
    Object.keys(rooms[roomId]).forEach(clientId => {
      const user = rooms[roomId][clientId]
      if (!user.connected && (now - user.lastSeen) > staleThreshold) {
        console.log(`Cleaning up stale user: ${clientId} in room ${roomId}`)
        delete rooms[roomId][clientId]
        
        if (Object.keys(rooms[roomId]).length === 0) {
          delete rooms[roomId]
        }
      }
    })
  })
}, 60000) // Run every minute

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...')
  
  // Clear all pending timeouts
  Object.values(pendingRemovals).forEach(timeout => clearTimeout(timeout))
  
  // Close server
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`)
  console.log(`Health check available at http://localhost:${PORT}/health`)
})