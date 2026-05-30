// notifications/notification.controller.js
const express = require('express');
const router = express.Router();
const Notification = require('./notification.model');
const authorize = require('../_middleware/authorize');
const Account = require('../accounts/account.model');
const { sendExpoPush } = require('../messages/utils/push');

// Get all notifications for current user
router.get('/', authorize(), async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    const { page = 1, limit = 20, unreadOnly = false } = req.query;
    
    const query = { 
      recipient: userId,
      isDeleted: false
    };
    
    if (unreadOnly === 'true') {
      query.read = false;
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('sender', 'firstName lastName photos profileImage verified')
      .populate('post', 'content images author')
      .lean();
    
    const total = await Notification.countDocuments(query);
    const unreadCount = await Notification.countDocuments({ 
      recipient: userId, 
      read: false,
      isDeleted: false 
    });
    
    res.json({
      success: true,
      notifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      unreadCount
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    next(error);
  }
});

// Get unread count
router.get('/unread-count', authorize(), async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    
    const unreadCount = await Notification.countDocuments({ 
      recipient: userId, 
      read: false,
      isDeleted: false 
    });
    
    res.json({ success: true, unreadCount });
  } catch (error) {
    next(error);
  }
});

// Mark notification as read
router.put('/:id/read', authorize(), async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    const { id } = req.params;
    
    const notification = await Notification.findOneAndUpdate(
      { _id: id, recipient: userId },
      { read: true },
      { new: true }
    );
    
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    
    res.json({ success: true, notification });
  } catch (error) {
    next(error);
  }
});

// Mark all notifications as read
router.put('/read-all', authorize(), async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    
    await Notification.updateMany(
      { recipient: userId, read: false },
      { read: true }
    );
    
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    next(error);
  }
});

// Delete a notification
router.delete('/:id', authorize(), async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    const { id } = req.params;
    
    const notification = await Notification.findOneAndUpdate(
      { _id: id, recipient: userId },
      { isDeleted: true },
      { new: true }
    );
    
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    next(error);
  }
});

// Helper function to create notification (exported for use in other controllers)
async function createNotification({ recipient, sender, type, post, comment, chatroomMessage, chatroom, chatroomName, message }) {
  // Don't create notification if sender is same as recipient
  if (String(recipient) === String(sender)) {
    return null;
  }
  
  let notification = null;
  try {
    notification = new Notification({
      recipient,
      sender,
      type,
      post,
      comment,
      chatroomMessage,
      chatroom,
      chatroomName,
      message
    });
    
    await notification.save();
    
    // Populate sender info for socket emission
    await notification.populate('sender', 'firstName lastName photos profileImage verified');
    if (post) {
      await notification.populate('post', 'content images author');
    }
    if (chatroomMessage) {
      await notification.populate('chatroomMessage', 'message chatroomId');
    }
  } catch (error) {
    console.error('Create notification error:', error);
    return null;
  }

  // Best-effort push to recipient — non-blocking so a push failure never breaks the caller
  try {
    const recipientAccount = await Account.findById(recipient).select('expoPushToken pushToken').lean();
    const pushToken = recipientAccount?.expoPushToken || recipientAccount?.pushToken;
    const senderName = notification?.sender?.firstName || 'Someone';

    if (pushToken) {
      let pushTitle = 'New notification';
      let pushBody  = '';
      let channelId = 'default';
      let data      = { kind: 'notification', type };

      if (type === 'like_post' || type === 'like_comment' || type === 'like_reply') {
        pushTitle = `${senderName} liked your ${type === 'like_post' ? 'post' : 'comment'}`;
        channelId = 'default';
        if (post) data = { kind: 'mention', postId: String(post?._id || post), type };
      } else if (type === 'comment') {
        pushTitle = `${senderName} commented on your post`;
        pushBody  = message || '';
        channelId = 'mentions';
        if (post) data = { kind: 'mention', postId: String(post?._id || post), type };
      } else if (type === 'mention_post' || type === 'mention_comment' || type === 'mention_reply') {
        pushTitle = `${senderName} mentioned you`;
        pushBody  = message || '';
        channelId = 'mentions';
        if (post) data = { kind: 'mention', postId: String(post?._id || post), type };
      } else if (type === 'reply_comment' || type === 'reply_thread') {
        pushTitle = `${senderName} replied to your comment`;
        pushBody  = message || '';
        channelId = 'mentions';
        if (post) data = { kind: 'mention', postId: String(post?._id || post), type };
      } else if (type === 'connection_request') {
        pushTitle = `${senderName} sent you a connection request`;
        channelId = 'connections';
        data = { kind: 'connection', type, senderId: String(sender) };
      } else if (type === 'connection_accepted') {
        pushTitle = `${senderName} accepted your connection request`;
        channelId = 'connections';
        data = { kind: 'connection', type, senderId: String(sender) };
      } else if (type === 'chatroom_mention') {
        pushTitle = `${senderName} mentioned you in a group`;
        pushBody  = message || '';
        channelId = 'group-messages';
        if (chatroom) data = { kind: 'group', chatroomId: String(chatroom), chatroomName: chatroomName || 'Group', type };
      } else if (type === 'chatroom_like' || type === 'chatroom_reply') {
        pushTitle = `${senderName} ${type === 'chatroom_like' ? 'liked' : 'replied to'} your message`;
        channelId = 'group-messages';
        if (chatroom) data = { kind: 'group', chatroomId: String(chatroom), chatroomName: chatroomName || 'Group', type };
      } else if (type === 'share') {
        pushTitle = `${senderName} shared your post`;
        channelId = 'default';
        if (post) data = { kind: 'mention', postId: String(post?._id || post), type };
      } else if (type === 'follow') {
        pushTitle = `${senderName} followed you`;
        channelId = 'connections';
        data = { kind: 'connection', type, senderId: String(sender) };
      }

      await sendExpoPush({ to: pushToken, title: pushTitle, body: pushBody, channelId, data });
    }
  } catch (pushErr) {
    console.error('Notification push error:', pushErr?.message);
  }

  return notification;
}

module.exports = router;
module.exports.createNotification = createNotification;
