

// // message.controller.js
// const messageService = require('./message.service');
// const db = require('_helpers/db');
// const { sendExpoPush } = require('./utils/push'); // ← add this import


// module.exports = {
//   sendMessage,
//   getMessages,
//   getConversations
// };

// function makePairKey(a, b) {
//   const [x, y] = [String(a), String(b)].sort();
//   return `dm:${x}_${y}`;
// }

// async function sendMessage(req, res, next) {
//   try {
//     const senderId = req.user.id;
//     const { recipientId, message } = req.body;

//     // 1) Persist
//     const created = await messageService.create({ senderId, recipientId, message });

//     // 2) Derive senderName + preview (safe fallbacks)
//     const senderName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() || 'Someone';
//     const preview = (message || '').toString().slice(0, 80);

//     // 3) Wire up socket
//     const io = req.app.get('io');
//     const connectedUsers = req.app.get('connectedUsers');

//     // ✅ A) Direct-to-socket (only the recipient hears/gets it)
//     const recipientSocketId = connectedUsers?.[recipientId];
//     if (recipientSocketId) {
//       io.to(recipientSocketId).emit('newMessage', {
//         // keep old shape, but include meta so your toast has data
//         message: created,
//         meta: {
//           kind: 'dm',
//           senderId,
//           senderName,
//           preview,
//         }
//       });
// const room = makePairKey(senderId, recipientId);

// // let the chat list update its lastMessage/ts and bump unread for the recipient
// io.to(room).emit('conversation:update', {
//   peerA: senderId,
//   peerB: recipientId,
//   lastMessage: preview,
//   timestamp: created.timestamp || Date.now(),
//   unreadBumpFor: recipientId
// });

//     }
// try {
//       const recipient = await db.Account.findById(recipientId).lean().exec();
//       const recipientPushToken = recipient?.expoPushToken || recipient?.pushToken; // adjust to your schema
//       if (recipientPushToken) {
//         await sendExpoPush({
//           to: recipientPushToken,
//           sound: 'default',
//           title: `New message from ${senderName}`,
//           body: preview,
//           data: {
//             kind: 'dm',
//             senderId,
//             senderName,
//             otherUserId: senderId,
//             preview,
//           },
//         });
//       }
//     } catch (e) {
//       console.error('Failed to send Expo push:', e?.message || e);
//     }
   

//     // 4) Respond
//     res.json(created);
//   } catch (err) {
//     next(err);
//   }
// }

// async function getMessages(req, res, next) {
//   try {
//     const currentUserId = req.user.id;
//     const otherUserId = req.params.userId;
//     const messages = await messageService.getMessagesBetweenUsers(currentUserId, otherUserId);

//     // It's fine to keep read receipt room emits here
//     const io = req.app.get('io');
//     const room = `dm:${[String(currentUserId), String(otherUserId)].sort().join('_')}`;
//     io.to(room).emit('message:read', { readerId: currentUserId, otherId: otherUserId });
//     io.to(room).emit('conversation:update', {
//       peerA: currentUserId,
//       peerB: otherUserId,
//       unreadResetFor: currentUserId
//     });

//     res.json(messages);
//   } catch (err) {
//     next(err);
//   }
// }

// async function getConversations(req, res, next) {
//   try {
//     const currentUserId = req.user.id;
//     const conversations = await messageService.getUserConversations(currentUserId);
//     res.json(conversations);
//   } catch (err) {
//     next(err);
//   }
// }


// messages/message.controller.js
const messageService = require('./message.service');
const db = require('_helpers/db');
const { sendExpoPush } = require('./utils/push');
const containsObjectionableContent = require('../utils/filterObjectionableContent');
const Block = require('../blockUser/block.model'); // import if not already


module.exports = {
  sendMessage,
  getMessages,
  getConversations,
  addReaction,
  removeReaction,
  deleteMessage,
};

function makePairKey(a, b) {
  const [x, y] = [String(a), String(b)].sort();
  return `dm:${x}_${y}`;
}

async function sendMessage(req, res, next) {
  try {
    const senderId = req.user.id;
    const { 
      recipientId, 
      message, 
      replyTo,
      // Media fields
      messageType,
      mediaUrl,
      fileName,
      fileSize,
      mimeType,
      duration,
      thumbnail,
      contactInfo,
    } = req.body;

    // 🚨 Filter objectionable content (only for text messages)
if (message && messageType !== 'contact' && containsObjectionableContent(message)) {
return res.status(400).json({ message: 'Message contains inappropriate content.' });
}

// 🚫 Check block status (bidirectional)
const isBlocked = await Block.findOne({
$or: [
{ blocker: senderId, blocked: recipientId },
{ blocker: recipientId, blocked: senderId }
]
});


if (isBlocked) {
return res.status(403).json({ message: 'Messaging not allowed. One of the users has blocked the other.' });
}

    // 1) Persist (including media fields)
    const created = await messageService.create({ 
      senderId, 
      recipientId, 
      message, 
      replyTo,
      messageType,
      mediaUrl,
      fileName,
      fileSize,
      mimeType,
      duration,
      thumbnail,
      contactInfo,
    });

    // 1b) Ensure consistent populated payload (keeps client shape uniform)
    const saved =
      (messageService.findByIdPopulated
        ? await messageService.findByIdPopulated(created._id)
        : null) || created;

    // 2) Derive meta
    // const senderName =
    //   [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() || 'Someone';
    // const preview = (message || '').toString().slice(0, 80);

     const senderAccount = await db.Account.findById(senderId).select('firstName lastName').lean();
    const senderName = [senderAccount?.firstName, senderAccount?.lastName].filter(Boolean).join(' ').trim() || 'Someone';
    
    // Generate preview based on message type
    let preview;
    if (messageType === 'image') {
      preview = '📷 Photo';
    } else if (messageType === 'audio') {
      preview = '🎤 Voice message';
    } else if (messageType === 'document') {
      preview = `📄 ${fileName || 'Document'}`;
    } else if (messageType === 'contact') {
      preview = `👤 Contact: ${contactInfo?.name || 'Unknown'}`;
    } else {
      preview = (message || '').toString().slice(0, 80);
    }

    // 3) Sockets
    const io = req.app.get('io');
    const connectedUsers = req.app.get('connectedUsers');
    const room = makePairKey(senderId, recipientId);

    // A) Direct notify recipient
    const recipientSocketId = connectedUsers?.[recipientId];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('newMessage', {
        message: saved, // populated for consistent client shape
        meta: {
          kind: 'dm',
          senderId: String(senderId),
          senderName,
          preview,
        },
      });

      // Bump conversation row in the DM room
       const senderSocketId    = connectedUsers?.[senderId];
    const payload = {
      peerA: String(senderId),
      peerB: String(recipientId),
      lastMessage: preview,
      timestamp: saved?.timestamp || Date.now(),
      unreadBumpFor: String(recipientId), // recipient gets 1
    };
    if (senderSocketId)    io.to(senderSocketId).emit('conversation:update', payload);
    if (recipientSocketId) io.to(recipientSocketId).emit('conversation:update', payload);
      // io.to(room).emit('conversation:update', {
      //   peerA: String(senderId),
      //   peerB: String(recipientId),
      //   lastMessage: preview,
      //   timestamp: saved?.timestamp || Date.now(), // keep your 'timestamp' field
      //   unreadBumpFor: String(recipientId),
      // });
    }

    // 4) Push notification — only for offline recipients (socket handles foreground delivery)
    try {
      const isRecipientOnline = Boolean(connectedUsers?.[String(recipientId)]);
      if (!isRecipientOnline) {
        const recipient = await db.Account.findById(recipientId).lean().exec();
        const recipientPushToken = recipient?.expoPushToken || recipient?.pushToken;
        if (recipientPushToken) {
          await sendExpoPush({
            to: recipientPushToken,
            sound: 'default',
            title: `New message from ${senderName}`,
            body: preview,
            data: {
              kind: 'dm',
              senderId: String(senderId),
              senderName,
              otherUserId: String(senderId),
              preview,
            },
          });
        }
      }
    } catch (e) {
      console.error('Failed to send Expo push:', e?.message || e);
    }

    // 5) Respond
    res.json(saved);
  } catch (err) {
    next(err);
  }
}

async function getMessages(req, res, next) {
  try {
    const currentUserId = req.user.id;
    const otherUserId = req.params.userId;

    // Return populated messages for consistent client shape
    const messages = await messageService.getMessagesBetweenUsers(currentUserId, otherUserId);

    // Read + conversation updates for this DM room
    const io = req.app.get('io');
    const room = makePairKey(currentUserId, otherUserId);

    io.to(room).emit('message:read', {
      readerId: String(currentUserId),
      otherId: String(otherUserId),
    });

    io.to(room).emit('conversation:update', {
      peerA: String(currentUserId),
      peerB: String(otherUserId),
      unreadResetFor: String(currentUserId),
    });

    res.json(messages);
  } catch (err) {
    next(err);
  }
}

async function getConversations(req, res, next) {
  try {
    const currentUserId = req.user.id;
    const conversations = await messageService.getUserConversations(currentUserId);
    res.json(conversations);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────
// Reaction handlers
// ─────────────────────────────────────────────────────────
async function addReaction(req, res, next) {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ message: 'Emoji is required' });
    }

    const updatedMessage = await messageService.addReaction(messageId, userId, emoji);
    
    // Emit socket event for real-time update
    const io = req.app.get('io');
    const connectedUsers = req.app.get('connectedUsers');
    
    // Notify both sender and recipient of the message
    const senderId = String(updatedMessage.senderId?._id || updatedMessage.senderId);
    const recipientId = String(updatedMessage.recipientId?._id || updatedMessage.recipientId);
    
    const reactionPayload = {
      messageId,
      reactions: updatedMessage.reactions,
      addedBy: userId,
      emoji,
    };

    const senderSocketId = connectedUsers?.[senderId];
    const recipientSocketId = connectedUsers?.[recipientId];
    
    if (senderSocketId) io.to(senderSocketId).emit('message:reaction', reactionPayload);
    if (recipientSocketId && recipientSocketId !== senderSocketId) {
      io.to(recipientSocketId).emit('message:reaction', reactionPayload);
    }

    res.json(updatedMessage);
  } catch (err) {
    next(err);
  }
}

async function removeReaction(req, res, next) {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;

    const updatedMessage = await messageService.removeReaction(messageId, userId);
    
    // Emit socket event for real-time update
    const io = req.app.get('io');
    const connectedUsers = req.app.get('connectedUsers');
    
    const senderId = String(updatedMessage.senderId?._id || updatedMessage.senderId);
    const recipientId = String(updatedMessage.recipientId?._id || updatedMessage.recipientId);
    
    const reactionPayload = {
      messageId,
      reactions: updatedMessage.reactions,
      removedBy: userId,
    };

    const senderSocketId = connectedUsers?.[senderId];
    const recipientSocketId = connectedUsers?.[recipientId];
    
    if (senderSocketId) io.to(senderSocketId).emit('message:reaction', reactionPayload);
    if (recipientSocketId && recipientSocketId !== senderSocketId) {
      io.to(recipientSocketId).emit('message:reaction', reactionPayload);
    }

    res.json(updatedMessage);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────
// Delete Message Handler (WhatsApp-style)
// ─────────────────────────────────────────────────────────
async function deleteMessage(req, res, next) {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const { deleteType } = req.body; // 'me' or 'everyone'

    if (!deleteType || !['me', 'everyone'].includes(deleteType)) {
      return res.status(400).json({ message: "deleteType must be 'me' or 'everyone'" });
    }

    let result;
    
    if (deleteType === 'everyone') {
      result = await messageService.deleteMessage(messageId, userId);
    } else {
      result = await messageService.deleteMessageForMe(messageId, userId);
    }

    // Emit socket event for real-time update
    const io = req.app.get('io');
    const connectedUsers = req.app.get('connectedUsers');

    const senderId = String(result.senderId?._id || result.senderId);
    const recipientId = String(result.recipientId?._id || result.recipientId);

    const deletePayload = {
      messageId,
      deleteType,
      deletedBy: String(userId),
    };

    // For "delete for everyone", notify both users
    // For "delete for me", only notify the user who deleted
    if (deleteType === 'everyone') {
      const senderSocketId = connectedUsers?.[senderId];
      const recipientSocketId = connectedUsers?.[recipientId];
      
      if (senderSocketId) io.to(senderSocketId).emit('message:deleted', deletePayload);
      if (recipientSocketId && recipientSocketId !== senderSocketId) {
        io.to(recipientSocketId).emit('message:deleted', deletePayload);
      }
    } else {
      // Delete for me - only notify the user who deleted
      const userSocketId = connectedUsers?.[userId];
      if (userSocketId) io.to(userSocketId).emit('message:deleted', deletePayload);
    }

    res.json({ success: true, messageId, deleteType });
  } catch (err) {
    console.error('Delete message error:', err.message);
    if (err.message === 'Message not found') {
      return res.status(404).json({ message: 'Message not found' });
    }
    if (err.message === 'You can only delete your own messages for everyone') {
      return res.status(403).json({ message: err.message });
    }
    next(err);
  }
}
