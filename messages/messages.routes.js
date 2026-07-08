// const express = require('express');
// const router = express.Router();
// const authorize = require('_middleware/authorize');
// const controller = require('./message.controller');

// router.post('/', authorize(), controller.sendMessage);
// router.get('/:userId', authorize(), controller.getMessages);
// router.get('/conversations/list', authorize(), controller.getConversations);


// module.exports = router;


const express = require('express');
const router = express.Router();
const authorize = require('_middleware/authorize');
const controller = require('./message.controller');

// ✅ Put static route BEFORE the param route
router.get('/conversations/list', authorize(), controller.getConversations);
router.get('/:userId', authorize(), controller.getMessages);
router.post('/', authorize(), controller.sendMessage);

// Reactions endpoints
router.post('/:messageId/react', authorize(), controller.addReaction);
router.delete('/:messageId/react', authorize(), controller.removeReaction);

// Delete message endpoint (WhatsApp-style)
router.delete('/:messageId', authorize(), controller.deleteMessage);

module.exports = router;
