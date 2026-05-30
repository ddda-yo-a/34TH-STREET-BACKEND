const express = require('express');
const router = express.Router();
const Joi = require('joi');
const validateRequest = require('../_middleware/validate-request');
const authorize = require('../_middleware/authorize');
const Role = require('../_helpers/role');
const alumniRequestService = require('./alumniRequest.service');

// ─── Public Routes ─────────────────────────────────────
router.post('/send-otp', sendOtpSchema, sendOtp);
router.post('/resend-otp', resendOtpSchema, resendOtp);
router.post('/verify-otp', verifyOtpSchema, verifyOtp);
router.post('/submit', submitSchema, submit);

// ─── Admin Routes ──────────────────────────────────────
router.get('/', authorize(Role.Admin), getAll);
router.get('/stats', authorize(Role.Admin), getStats);
router.post('/migrate-backfill', authorize(Role.Admin), backfillApprovedAccounts);
router.get('/:id', authorize(Role.Admin), getById);
router.post('/:id/approve', authorize(Role.Admin), approveRequest);
router.post('/:id/deny', authorize(Role.Admin), denyRequest);

module.exports = router;

// ─── Schema Validators ─────────────────────────────────

function sendOtpSchema(req, res, next) {
  const schema = Joi.object({
    personalEmail: Joi.string().email().required(),
    firstName: Joi.string().allow('', null),
  });
  validateRequest(req, next, schema);
}

function resendOtpSchema(req, res, next) {
  const schema = Joi.object({
    personalEmail: Joi.string().email().required(),
    firstName: Joi.string().allow('', null),
  });
  validateRequest(req, next, schema);
}

function verifyOtpSchema(req, res, next) {
  const schema = Joi.object({
    personalEmail: Joi.string().email().required(),
    otp: Joi.string().length(6).required(),
  });
  validateRequest(req, next, schema);
}

function submitSchema(req, res, next) {
  const schema = Joi.object({
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    gender: Joi.string().valid('Male', 'Female', 'Non-binary').required(),
    phone: Joi.string().required(),
    personalEmail: Joi.string().email().required(),
    workEmail: Joi.string().email().allow('', null).optional(),
    schoolGraduatedFrom: Joi.string().required(),
    degreeHeld: Joi.string().required(),
    graduationYear: Joi.string().length(4).pattern(/^[0-9]+$/).allow('', null).optional(),
    linkedIn: Joi.string().uri().required(),
    password: Joi.string().min(6).required(),
    confirmPassword: Joi.string().valid(Joi.ref('password')).required(),
  });
  validateRequest(req, next, schema);
}

// ─── Route Handlers ─────────────────────────────────────

function sendOtp(req, res, next) {
  alumniRequestService.sendOtp(req.body).then((r) => res.json(r)).catch(next);
}

function resendOtp(req, res, next) {
  alumniRequestService.resendOtp(req.body).then((r) => res.json(r)).catch(next);
}

function verifyOtp(req, res, next) {
  alumniRequestService.verifyOtp(req.body).then((r) => res.json(r)).catch(next);
}

function submit(req, res, next) {
  alumniRequestService.submitRequest(req.body).then((r) => res.status(201).json(r)).catch(next);
}

function getAll(req, res, next) {
  const { status, page, limit, search } = req.query;
  alumniRequestService.getAll({ status, page: parseInt(page) || 1, limit: parseInt(limit) || 20, search })
    .then((r) => res.json(r)).catch(next);
}

function getStats(req, res, next) {
  alumniRequestService.getStats().then((r) => res.json(r)).catch(next);
}

function getById(req, res, next) {
  alumniRequestService.getById(req.params.id).then((r) => res.json(r)).catch(next);
}

function approveRequest(req, res, next) {
  alumniRequestService.approve(req.params.id, req.user.id).then((r) => res.json(r)).catch(next);
}

function denyRequest(req, res, next) {
  const reason = req.body.reason || null;
  alumniRequestService.deny(req.params.id, req.user.id, reason).then((r) => res.json(r)).catch(next);
}

/**
 * POST /api/alumni-requests/migrate-backfill  (Admin only)
 *
 * One-time migration: for every approved alumni request, find the linked
 * Account and patch any missing schoolGraduatedFrom / fieldOfStudy fields.
 * Safe to run multiple times — only overwrites null/empty values.
 */
async function backfillApprovedAccounts(req, res, next) {
  try {
    const AlumniRequest = require('./alumniRequest.model');
    const Account = require('../accounts/account.model');

    const approved = await AlumniRequest.find({ status: 'approved' });
    const results = { updated: 0, skipped: 0, errors: [] };

    for (const request of approved) {
      try {
        // Alumni login email is workEmail (if provided) or personalEmail
        const loginEmail = (request.workEmail && request.workEmail !== 'pending@pending.com')
          ? request.workEmail
          : request.personalEmail;

        const account = await Account.findOne({ email: loginEmail });
        if (!account) { results.skipped++; continue; }

        let changed = false;

        // Backfill schoolGraduatedFrom if missing
        if (!account.schoolGraduatedFrom && request.schoolGraduatedFrom) {
          account.schoolGraduatedFrom = request.schoolGraduatedFrom;
          changed = true;
        }

        // Backfill fieldOfStudy (degreeHeld) if missing
        if (!account.fieldOfStudy && request.degreeHeld) {
          account.fieldOfStudy = request.degreeHeld;
          changed = true;
        }

        if (changed) {
          await account.save();
          results.updated++;
        } else {
          results.skipped++;
        }
      } catch (err) {
        results.errors.push({ email: request.personalEmail, error: err.message });
      }
    }

    res.json({
      message: 'Alumni backfill complete.',
      ...results,
    });
  } catch (err) {
    next(err);
  }
}
