import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*' }
})

// rooms: { [roomId]: { [clientId]: socketId } }
const rooms = {}
// pending removals: { [roomId:clientId]: Timeout }
const pendingRemovals = {}

io.on('connection', socket => {
  socket.on('join-room', ({ roomId, clientId }) => {
    const key = `${roomId}:${clientId}`
    // cancel pending removal on reconnect
    if (pendingRemovals[key]) {
      clearTimeout(pendingRemovals[key])
      delete pendingRemovals[key]
    }

    socket.data = { roomId, clientId }
    if (!rooms[roomId]) rooms[roomId] = {}
    rooms[roomId][clientId] = socket.id
    socket.join(roomId)

    // notify others in the room
    socket.to(roomId).emit('user-joined', { clientId, socketId: socket.id })
  })

  // Handle text messages
  socket.on('send-message', ({ message }) => {
    const { roomId, clientId } = socket.data || {}
    if (!roomId) return

    const messageData = {
      id: Date.now().toString(), // Simple message ID
      message,
      clientId,
      timestamp: new Date().toISOString()
    }

    // Send message to all users in the room (including sender for confirmation)
    io.to(roomId).emit('receive-message', messageData)
  })

  socket.on('signal', ({ toClientId, data }) => {
    const { roomId, clientId } = socket.data || {}
    if (!roomId) return
    const toSocket = rooms[roomId]?.[toClientId]
    if (toSocket) {
      io.to(toSocket).emit('signal', {
        fromClientId: clientId,
        data
      })
    }
  })

  socket.on('disconnect', () => {
    const { roomId, clientId } = socket.data || {}
    if (!roomId) return
    const key = `${roomId}:${clientId}`

    // schedule removal if not reconnected in 10s
    pendingRemovals[key] = setTimeout(() => {
      delete rooms[roomId]?.[clientId]
      socket.to(roomId).emit('user-left', { clientId })
      // delete empty room
      if (rooms[roomId] && Object.keys(rooms[roomId]).length === 0) {
        delete rooms[roomId]
      }
      delete pendingRemovals[key]
    }, 10000)
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`)
})