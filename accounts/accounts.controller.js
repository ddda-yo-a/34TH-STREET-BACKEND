
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const validateRequest = require('_middleware/validate-request');
const authorize = require('_middleware/authorize')
const Role = require('_helpers/role');
const accountService = require('./account.service');
const db = require('_helpers/db');
const upload = require('../_middleware/upload');
const jwt = require('jsonwebtoken');
const config = require('../config.js');
const Account = require('./account.model');
const bcrypt = require('bcryptjs');
const SchoolRequest = require('../schoolRequests/schoolRequest.model');
const AlumniRequest = require('../alumniRequests/alumniRequest.model');
const containsObjectionableContent = require('../utils/filterObjectionableContent');
const { addDistancesToUsers, sortByDistance } = require('../utils/locationUtils');


// routes
router.post('/authenticate', authenticateSchema, authenticate);
router.post('/refresh-token', refreshToken);
router.post('/revoke-token', authorize(), revokeTokenSchema, revokeToken);
router.post('/register', registerSchema, register);
router.post('/verify-email', verifyEmailSchema, verifyEmail);
router.post('/resend-otp', resendOTPSchema, resendOTP);
router.post('/forgot-password', forgotPasswordSchema, forgotPassword);
router.post('/validate-reset-token', validateResetTokenSchema, validateResetToken);
router.post('/reset-password', resetPasswordSchema, resetPassword);
router.get('/', authorize(Role.Admin), getAll);
router.get('/verified', authorize(), getVerifiedUsers);
router.put('/me/location', authorize(), updateMyLocation);
router.put('/me/location-settings', authorize(), updateLocationSettings);
router.get('/me/location', authorize(), getMyLocation);

router.get('/:id', authorize(), getById);
router.post('/push-token', authorize(), savePushToken);
router.get('/:id/presence', authorize(), getUserPresence);

// Onboarding coach marks
router.get('/me/onboarding', authorize(), getOnboardingState);
router.patch('/me/onboarding', authorize(), updateOnboardingState);

// Recovery email
router.post('/recovery-email/send-otp', authorize(), sendRecoveryOtp);
router.post('/recovery-email/verify-otp', authorize(), verifyRecoveryOtp);
router.post('/recovery-email/dismiss', authorize(), dismissRecoveryReminder);



router.post('/', authorize(Role.Admin), createSchema, create);
// router.put('/:id', authorize(), updateSchema, update);
router.put('/:id', authorize(), update);

// router.put('/:id', authorize(), upload.array('photos', 6), update); // no updateSchema here

// router.put('/:id', authorize(), upload.array('photos', 6), updateSchema, update);
router.delete('/:id', authorize(), _delete);

module.exports = router;

// const jwt = require('jsonwebtoken');



// const config = require('../config.json'); // Load config.json


function sanitizeField(value) {
    if (!value || typeof value !== "string") return value;
    return containsObjectionableContent(value) ? "" : value;
}

function sanitizeArray(arr) {
    if (!Array.isArray(arr)) return arr;
    return arr.map(item => sanitizeField(item));
}


function generateJwtToken(userId) {
    return jwt.sign({ userId: userId }, config.JWT_SECRET, { expiresIn: '7d' });
}
function authenticateSchema(req, res, next) {
    const schema = Joi.object({
        email: Joi.string().required(),
        password: Joi.string().required()
    });
    validateRequest(req, next, schema);
}
function authenticate(req, res, next) {
    const { email, password } = req.body;
    const ipAddress = req.ip;

    accountService.authenticate({ email, password, ipAddress })
        .then(({ jwtToken, refreshToken, ...account }) => {
            setTokenCookie(res, refreshToken);
            res.json({ ...account, id: account.id, user: account, token: jwtToken });
        })
        .catch(next);
}

async function savePushToken(req, res, next) {
    try {
        const userId = req.user.id;
        const { expoPushToken } = req.body;

        if (!expoPushToken) {
            return res.status(400).json({ message: 'Expo push token required' });
        }

        const account = await db.Account.findById(userId);
        account.expoPushToken = expoPushToken;
        await account.save();

        res.json({ message: '✅ Push token saved!' });
    } catch (err) {
        next(err);
    }
}


function refreshToken(req, res, next) {
    const token = req.cookies.refreshToken;
    const ipAddress = req.ip;
    accountService.refreshToken({ token, ipAddress })
        .then(({ refreshToken, ...account }) => {
            setTokenCookie(res, refreshToken);
            res.json(account);
        })
        .catch(next);
}

function revokeTokenSchema(req, res, next) {
    const schema = Joi.object({
        token: Joi.string().empty('')
    });
    validateRequest(req, next, schema);
}

function revokeToken(req, res, next) {
    // accept token from request body or cookie
    const token = req.body.token || req.cookies.refreshToken;
    const ipAddress = req.ip;

    if (!token) return res.status(400).json({ message: 'Token is required' });

    // users can revoke their own tokens and admins can revoke any tokens
    if (!req.user.ownsToken(token) && req.user.role !== Role.Admin) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    accountService.revokeToken({ token, ipAddress })
        .then(() => res.json({ message: 'Token revoked' }))
        .catch(next);
}

function registerSchema(req, res, next) {
    const schema = Joi.object({
        title: Joi.string(),
        firstName: Joi.string().required(),
        lastName: Joi.string().required(),
        email: Joi.string().email().required(),
        gender: Joi.string().valid('Male', 'Female', 'Non-binary').required(),

        // location: Joi.string().required(),
        type: Joi.string().required(),  // ✅ Required type field
        password: Joi.string().min(6).required(),
        confirmPassword: Joi.string().valid(Joi.ref('password')),
    });
    validateRequest(req, next, schema);
}


async function register(req, res) {
  try {
    req.body.firstName = sanitizeField(req.body.firstName);
    req.body.lastName = sanitizeField(req.body.lastName);
    req.body.type = sanitizeField(req.body.type);
    req.body.gender = sanitizeField(req.body.gender);

    const result = await accountService.register(req.body, req.get("origin"));

    if (!result.account && result.reason === "ALREADY_VERIFIED") {
      return res.status(409).json({ message: "Account already verified. Please login." });
    }

    return res.status(201).json({
      message: "Account created. Verify OTP to continue.",
      userId: result.account.id,
      email: result.account.email,
      otpSent: result.otpSent,
      status: "PENDING_VERIFICATION"
    });

  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ message: "Unexpected server error", error: err.toString() });
  }
}


function verifyEmailSchema(req, res, next) {
    const schema = Joi.object({
        token: Joi.string().required()
    });
    validateRequest(req, next, schema);
}

function verifyEmail(req, res, next) {
    accountService.verifyEmail(req.body)
        .then(() => res.json({ message: 'Verification successful, you can now login' }))
        .catch(next);
}

function resendOTPSchema(req, res, next) {
    const schema = Joi.object({
        email: Joi.string().email().required()
    });
    validateRequest(req, next, schema);
}

async function resendOTP(req, res, next) {
    try {
        const result = await accountService.resendOTP(req.body, req.get('origin'));
        return res.status(200).json({
            message: 'OTP sent successfully',
            email: result.email,
            otpSent: true
        });
    } catch (err) {
        console.error('Resend OTP error:', err?.message || err);
        return res.status(400).json({ message: err.toString() || 'Failed to resend OTP' });
    }
}



function getVerifiedUsers(req, res, next) {
    const currentUserId = req.user.id; // 🔐 comes from JWT authorize middleware
    const { sortByDistance: shouldSortByDistance } = req.query; // Optional query param

    Promise.all([
        accountService.getVerifiedUsers(),
        Account.findById(currentUserId).select('location locationSharingEnabled')
    ])
    .then(([users, currentUser]) => {
        // 🧼 filter out the logged-in user
        let filteredUsers = users.filter(user => user.id !== currentUserId);

        // 📍 Add distance information if current user has location
        if (currentUser?.location?.coordinates) {
            filteredUsers = addDistancesToUsers(currentUser, filteredUsers);
            
            // Sort by distance if requested
            if (shouldSortByDistance === 'true') {
                filteredUsers = sortByDistance(filteredUsers);
            }
        }

        res.json(filteredUsers);
    })
    .catch(next);
}


function forgotPasswordSchema(req, res, next) {
    const schema = Joi.object({
        email: Joi.string().email().required()
    });
    validateRequest(req, next, schema);
}

function forgotPassword(req, res, next) {
    accountService.forgotPassword(req.body, req.get('origin'))
        .then((result) => res.json({ 
            message: result.message || 'Please check your email for password reset instructions',
            success: result.success 
        }))
        .catch(next);
}

function validateResetTokenSchema(req, res, next) {
    const schema = Joi.object({
        token: Joi.string().required()
    });
    validateRequest(req, next, schema);
}

function validateResetToken(req, res, next) {
    accountService.validateResetToken(req.body)
        .then(() => res.json({ message: 'Token is valid' }))
        .catch(next);
}

function resetPasswordSchema(req, res, next) {
    const schema = Joi.object({
        token: Joi.string().required(),
        password: Joi.string().min(6).required(),
        confirmPassword: Joi.string().valid(Joi.ref('password')).required()
    });
    validateRequest(req, next, schema);
}

function resetPassword(req, res, next) {
    accountService.resetPassword(req.body)
        .then(() => res.json({ message: 'Password reset successful, you can now login' }))
        .catch(next);
}

function getAll(req, res, next) {
    accountService.getAll()
        .then(accounts => res.json(accounts))
        .catch(next);
}

function getById(req, res, next) {
    
    accountService.getById(req.params.id)
        .then(async account => {
            if (!account) return res.sendStatus(404);
            const data = account.toJSON ? account.toJSON() : { ...account };
            // Strip exact coordinates for privacy — only expose city name
            delete data.location;
            if (data.locationSharingEnabled === false) {
                data.currentCity = '';
                data.locationUpdatedAt = null;
            }

            // ── Live backfill: if schoolName or schoolGraduatedFrom is missing, recover it
            // from the original request record. This handles accounts approved before the
            // schoolName field was wired into the service. Once patched, future fetches skip this.
            try {
                let patched = false;

                // School-not-listed: look up SchoolRequest by school email
                if (!data.schoolName) {
                    const req2 = await SchoolRequest.findOne({
                        schoolEmail: data.email,
                        status: 'approved',
                    }).lean();
                    if (req2 && req2.schoolName) {
                        data.schoolName = req2.schoolName;
                        account.schoolName = req2.schoolName;
                        patched = true;
                    }
                    // Also backfill fieldOfStudy if missing
                    if (req2 && req2.program && !data.fieldOfStudy) {
                        data.fieldOfStudy = req2.program;
                        account.fieldOfStudy = req2.program;
                        patched = true;
                    }
                }

                // Alumni: look up AlumniRequest by work or personal email
                if (!data.schoolGraduatedFrom) {
                    const req3 = await AlumniRequest.findOne({
                        $or: [{ workEmail: data.email }, { personalEmail: data.email }],
                        status: 'approved',
                    }).lean();
                    if (req3 && req3.schoolGraduatedFrom) {
                        data.schoolGraduatedFrom = req3.schoolGraduatedFrom;
                        account.schoolGraduatedFrom = req3.schoolGraduatedFrom;
                        patched = true;
                    }
                    if (req3 && req3.degreeHeld && !data.fieldOfStudy) {
                        data.fieldOfStudy = req3.degreeHeld;
                        account.fieldOfStudy = req3.degreeHeld;
                        patched = true;
                    }
                }

                // Persist the backfilled values so future fetches skip this lookup
                if (patched) {
                    await account.save();
                }
            } catch (backfillErr) {
                // Non-fatal — just log and continue with whatever data we have
                console.warn('[getById] Live backfill failed (non-fatal):', backfillErr?.message);
            }

            return res.json({ user: data });
        })
        .catch(next);


}

// ✅ Get user presence/online status
async function getUserPresence(req, res, next) {
    try {
        const user = await Account.findById(req.params.id)
            .select('onlineStatus lastSeen lastActivity');
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        res.json({
            status: user.onlineStatus || 'offline',
            lastSeen: user.lastSeen,
            lastActivity: user.lastActivity
        });
    } catch (error) {
        next(error);
    }
}

function createSchema(req, res, next) {
    const schema = Joi.object({
        title: Joi.string().required(),
        firstName: Joi.string().required(),
        lastName: Joi.string().required(),
        email: Joi.string().email().required(),
        type: Joi.string().type().required(),
        password: Joi.string().min(6).required(),
        confirmPassword: Joi.string().valid(Joi.ref('password')).required(),
        role: Joi.string().valid(Role.Admin, Role.User).required()
    });
    validateRequest(req, next, schema);
}

function create(req, res, next) {
     // sanitize
    req.body.firstName = sanitizeField(req.body.firstName);
    req.body.lastName = sanitizeField(req.body.lastName);
    req.body.type = sanitizeField(req.body.type);
    accountService.create(req.body)
        .then(account => res.json(account))
        .catch(next);
}

function updateSchema(req, res, next) {
    const schema = Joi.object({
        email: Joi.string().email().empty(''),
        title: Joi.string().empty(''),
        firstName: Joi.string().empty(''),
        lastName: Joi.string().empty(''),
        password: Joi.string().min(6).empty(''),
        confirmPassword: Joi.string().valid(Joi.ref('password')).empty(''),
        gender: Joi.string().valid('Male', 'Female', 'Non-binary').empty(''),
        type: Joi.string().empty(''),
        bio: Joi.string().allow('', null),
        graduationYear: Joi.string().allow('', null),
        fieldOfStudy: Joi.string().allow('', null),
        currentRole: Joi.string().allow('', null),
        industry: Joi.string().allow('', null),
        linkedIn: Joi.string().uri().allow('', null),
        funFact: Joi.string().allow('', null),
        rship: Joi.string().valid('Single', 'Married', 'Dating', 'It’s complicated', 'Prefer not to say').allow('', null),
        phone: Joi.string().allow('', null),
        origin: Joi.string().allow('', null),
        nickname: Joi.string().allow('', null),
        currentCity: Joi.string().allow('', null),
locationUpdatedAt: Joi.date().allow(null),

        DOB: Joi.date().allow(null),
        languages: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()),
        interests: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()),
        photos: Joi.array().items(Joi.string()).optional()
    }).with('password', 'confirmPassword');

    validateRequest(req, next, schema);
}


async function updateMyLocation(req, res, next) {
  try {
    const userId = req.user?.id; // must exist from authorize middleware

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized: missing user id in token' });
    }

    let { currentCity, latitude, longitude, locationUpdatedAt, locationSharingEnabled } = req.body;

    console.log('📍 updateMyLocation:', { userId, currentCity, latitude, longitude });

    // Normalize city
    currentCity = typeof currentCity === 'string' ? currentCity.trim() : '';

    if (!currentCity) {
      return res.status(400).json({ message: 'currentCity is required' });
    }

    // ✅ sanitize city too
    currentCity = sanitizeField(currentCity);

    // Build the update payload
    const payload = {
      currentCity,
      locationUpdatedAt: locationUpdatedAt ? new Date(locationUpdatedAt) : new Date(),
    };

    // Add coordinates if provided (for Tinder-style distance calculation)
    if (latitude !== undefined && longitude !== undefined) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      
      if (!isNaN(lat) && !isNaN(lng)) {
        payload.location = {
          type: 'Point',
          coordinates: [lng, lat] // GeoJSON format: [longitude, latitude]
        };
      }
    }

    // Update location sharing preference if provided
    if (typeof locationSharingEnabled === 'boolean') {
      payload.locationSharingEnabled = locationSharingEnabled;
    }

    const updated = await accountService.update(userId, payload);

    // ✅ return the same shape your frontend expects elsewhere
    return res.json({ user: updated });

  } catch (err) {
    next(err);
  }
}

// 📍 Get current user's location data
async function getMyLocation(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const account = await Account.findById(userId)
      .select('currentCity location locationUpdatedAt locationSharingEnabled');

    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    // Extract coordinates safely
    const coordinates = account.location?.coordinates || [0, 0];
    const [longitude, latitude] = coordinates;

    res.json({
      currentCity: account.currentCity || '',
      latitude: latitude || null,
      longitude: longitude || null,
      locationUpdatedAt: account.locationUpdatedAt,
      locationSharingEnabled: account.locationSharingEnabled !== false
    });
  } catch (err) {
    next(err);
  }
}

// 📍 Update location sharing settings
async function updateLocationSettings(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { locationSharingEnabled } = req.body;

    if (typeof locationSharingEnabled !== 'boolean') {
      return res.status(400).json({ message: 'locationSharingEnabled must be a boolean' });
    }

    const updated = await accountService.update(userId, { locationSharingEnabled });

    res.json({ 
      user: updated,
      locationSharingEnabled: updated.locationSharingEnabled 
    });
  } catch (err) {
    next(err);
  }
}


function update(req, res, next) {
    if (req.params.id !== req.user.id && req.user.role !== Role.Admin) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    if (req.body.interests && typeof req.body.interests === 'string') {
        try {
            req.body.interests = JSON.parse(req.body.interests);
        } catch (err) {
            return res.status(400).json({ message: 'Invalid interests format' });
        }
    }

    // Sanitize free-text fields
    const textFields = [
        "firstName", "lastName", "nickname", "bio",
        "funFact", "currentRole", "industry",
        "fieldOfStudy", "origin", "type",
        "rship", "phone", "currentCity"
    ];

    textFields.forEach(field => {
        if (req.body[field]) {
            req.body[field] = sanitizeField(req.body[field]);
        }
    });

    // Sanitize arrays
    if (req.body.languages) req.body.languages = sanitizeArray(req.body.languages);
    if (req.body.interests) req.body.interests = sanitizeArray(req.body.interests);


    accountService.update(req.params.id, req.body)
        .then(account => res.json({ user: account }))
        .catch(next);
}






function _delete(req, res, next) {
    // users can delete their own account and admins can delete any account
    if (req.params.id !== req.user.id && req.user.role !== Role.Admin) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    accountService.delete(req.params.id)
        .then(() => res.json({ message: 'Account deleted successfully' }))
        .catch(next);
}

// helper functions

function randomTokenString() {
    const crypto = require('crypto');
    return crypto.randomBytes(40).toString('hex');
}

function setTokenCookie(res, token) {
    // create cookie with refresh token that expires in 7 days
    const cookieOptions = {
        httpOnly: true,
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    };
    res.cookie('refreshToken', token, cookieOptions);
}

// Onboarding coach marks

async function getOnboardingState(req, res, next) {
    try {
        const account = await Account.findById(req.user.id).select('onboardingCompleted');
        if (!account) return res.status(404).json({ message: 'Account not found' });
        res.json({ completedScreens: account.onboardingCompleted || [] });
    } catch (err) {
        next(err);
    }
}

async function updateOnboardingState(req, res, next) {
    try {
        const { completedScreens } = req.body;
        if (!Array.isArray(completedScreens)) {
            return res.status(400).json({ message: 'completedScreens must be an array' });
        }

        const account = await Account.findByIdAndUpdate(
            req.user.id,
            { $addToSet: { onboardingCompleted: { $each: completedScreens } } },
            { new: true }
        ).select('onboardingCompleted');

        if (!account) return res.status(404).json({ message: 'Account not found' });
        res.json({ completedScreens: account.onboardingCompleted });
    } catch (err) {
        next(err);
    }
}

// ─── Recovery Email ───────────────────────────────────────

async function sendRecoveryOtp(req, res, next) {
    try {
        const { recoveryEmail } = req.body;
        if (!recoveryEmail || typeof recoveryEmail !== 'string') {
            return res.status(400).json({ message: 'Recovery email is required' });
        }
        // Basic email format check
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail)) {
            return res.status(400).json({ message: 'Invalid email format' });
        }
        const result = await accountService.sendRecoveryOtp({
            userId: req.user.id,
            recoveryEmail: recoveryEmail.toLowerCase().trim()
        });
        res.json(result);
    } catch (err) {
        if (typeof err === 'string') return res.status(400).json({ message: err });
        next(err);
    }
}

async function verifyRecoveryOtp(req, res, next) {
    try {
        const { otp } = req.body;
        if (!otp || typeof otp !== 'string' || otp.length !== 6) {
            return res.status(400).json({ message: 'A 6-digit OTP is required' });
        }
        const result = await accountService.verifyRecoveryOtp({
            userId: req.user.id,
            otp: otp.trim()
        });
        res.json(result);
    } catch (err) {
        if (typeof err === 'string') return res.status(400).json({ message: err });
        next(err);
    }
}

async function dismissRecoveryReminder(req, res, next) {
    try {
        const result = await accountService.dismissRecoveryReminder({
            userId: req.user.id
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
}



// const express = require('express');
// const router = express.Router();
// const Joi = require('joi');
// const validateRequest = require('_middleware/validate-request');
// const authorize = require('_middleware/authorize')
// const Role = require('_helpers/role');
// const accountService = require('./account.service');
// const upload = require('../_middleware/upload');
// const jwt = require('jsonwebtoken');
// const config = require('../config.json');
// const Account = require('./account.model');
// const bcrypt = require('bcryptjs');
// const containsObjectionableContent = require('../utils/filterObjectionableContent');


// // routes
// router.post('/authenticate', authenticateSchema, authenticate);
// router.post('/refresh-token', refreshToken);
// router.post('/revoke-token', authorize(), revokeTokenSchema, revokeToken);
// router.post('/register', registerSchema, register);
// router.post('/verify-email', verifyEmailSchema, verifyEmail);
// router.post('/forgot-password', forgotPasswordSchema, forgotPassword);
// router.post('/validate-reset-token', validateResetTokenSchema, validateResetToken);
// router.post('/reset-password', resetPasswordSchema, resetPassword);
// router.get('/', authorize(Role.Admin), getAll);
// router.get('/verified', authorize(), getVerifiedUsers);
// router.get('/:id', authorize(), getById);
// router.post('/push-token', authorize(), savePushToken);



// router.post('/', authorize(Role.Admin), createSchema, create);
// // router.put('/:id', authorize(), updateSchema, update);
// router.put('/:id', authorize(), update);

// // router.put('/:id', authorize(), upload.array('photos', 6), update); // no updateSchema here

// // router.put('/:id', authorize(), upload.array('photos', 6), updateSchema, update);
// router.delete('/:id', authorize(), _delete);

// module.exports = router;

// // const jwt = require('jsonwebtoken');



// // const config = require('../config.json'); // Load config.json


// function sanitizeField(value) {
//     if (!value || typeof value !== "string") return value;
//     return containsObjectionableContent(value) ? "" : value;
// }

// function sanitizeArray(arr) {
//     if (!Array.isArray(arr)) return arr;
//     return arr.map(item => sanitizeField(item));
// }


// function generateJwtToken(userId) {
//     return jwt.sign({ userId: userId }, config.JWT_SECRET, { expiresIn: '7d' });
// }
// function authenticateSchema(req, res, next) {
//     const schema = Joi.object({
//         email: Joi.string().required(),
//         password: Joi.string().required()
//     });
//     validateRequest(req, next, schema);
// }
// function authenticate(req, res, next) {
//     const { email, password } = req.body;
//     const ipAddress = req.ip;

//     accountService.authenticate({ email, password, ipAddress })
//         .then(({ jwtToken, refreshToken, ...account }) => {
//             setTokenCookie(res, refreshToken);
//             res.json({ ...account, token: jwtToken }); // ✅ Include token
//         })
//         .catch(next);
// }

// async function savePushToken(req, res, next) {
//     try {
//         const userId = req.user.id;
//         const { expoPushToken } = req.body;

//         if (!expoPushToken) {
//             return res.status(400).json({ message: 'Expo push token required' });
//         }

//         const account = await db.Account.findById(userId);
//         account.expoPushToken = expoPushToken;
//         await account.save();

//         res.json({ message: '✅ Push token saved!' });
//     } catch (err) {
//         next(err);
//     }
// }


// function refreshToken(req, res, next) {
//     const token = req.cookies.refreshToken;
//     const ipAddress = req.ip;
//     accountService.refreshToken({ token, ipAddress })
//         .then(({ refreshToken, ...account }) => {
//             setTokenCookie(res, refreshToken);
//             res.json(account);
//         })
//         .catch(next);
// }

// function revokeTokenSchema(req, res, next) {
//     const schema = Joi.object({
//         token: Joi.string().empty('')
//     });
//     validateRequest(req, next, schema);
// }

// function revokeToken(req, res, next) {
//     // accept token from request body or cookie
//     const token = req.body.token || req.cookies.refreshToken;
//     const ipAddress = req.ip;

//     if (!token) return res.status(400).json({ message: 'Token is required' });

//     // users can revoke their own tokens and admins can revoke any tokens
//     if (!req.user.ownsToken(token) && req.user.role !== Role.Admin) {
//         return res.status(401).json({ message: 'Unauthorized' });
//     }

//     accountService.revokeToken({ token, ipAddress })
//         .then(() => res.json({ message: 'Token revoked' }))
//         .catch(next);
// }

// function registerSchema(req, res, next) {
//     const schema = Joi.object({
//         title: Joi.string(),
//         firstName: Joi.string().required(),
//         lastName: Joi.string().required(),
//         email: Joi.string().email().required(),
//         gender: Joi.string().valid('Male', 'Female', 'Non-binary').required(),

//         // location: Joi.string().required(),
//         type: Joi.string().required(),  // ✅ Required type field
//         password: Joi.string().min(6).required(),
//         confirmPassword: Joi.string().valid(Joi.ref('password')),
//     });
//     validateRequest(req, next, schema);
// }






// function register(req, res, next) {
//     // Sanitize fields
//     req.body.firstName = sanitizeField(req.body.firstName);
//     req.body.lastName = sanitizeField(req.body.lastName);
//     req.body.type = sanitizeField(req.body.type);
//     req.body.gender = sanitizeField(req.body.gender);
//     accountService.register(req.body, req.get('origin'))
//         .then(user => {
//             if (!user) {
//                 console.error("User registration failed - no user returned");
//                 return res.status(400).json({ message: "User registration failed" });
//             }

//             // Generate JWT token after successful registration
//             // const token = generateJwtToken(user);
//             const token = generateJwtToken(user.id);


//             res.json({
//                 message: "Registration successful, please check your email for verification instructions",
//                 token: token,
//                 userId: user.id
//             });
//         })
//         .catch(error => {
//             console.error("User registration error:", error);
//             res.status(500).json({ message: "User registration failed", error: error.toString() });
//         });
// }






// function verifyEmailSchema(req, res, next) {
//     const schema = Joi.object({
//         token: Joi.string().required()
//     });
//     validateRequest(req, next, schema);
// }

// function verifyEmail(req, res, next) {
//     accountService.verifyEmail(req.body)
//         .then(() => res.json({ message: 'Verification successful, you can now login' }))
//         .catch(next);
// }



// function getVerifiedUsers(req, res, next) {
//     const currentUserId = req.user.id; // 🔐 comes from JWT authorize middleware

//     accountService.getVerifiedUsers()
//         .then(users => {
//             // 🧼 filter out the logged-in user
//             const filteredUsers = users.filter(user => user.id !== currentUserId);
//             res.json(filteredUsers);
//         })
//         .catch(next);
// }


// function forgotPasswordSchema(req, res, next) {
//     const schema = Joi.object({
//         email: Joi.string().email().required()
//     });
//     validateRequest(req, next, schema);
// }

// function forgotPassword(req, res, next) {
//     accountService.forgotPassword(req.body, req.get('origin'))
//         .then(() => res.json({ message: 'Please check your email for password reset instructions' }))
//         .catch(next);
// }

// function validateResetTokenSchema(req, res, next) {
//     const schema = Joi.object({
//         token: Joi.string().required()
//     });
//     validateRequest(req, next, schema);
// }

// function validateResetToken(req, res, next) {
//     accountService.validateResetToken(req.body)
//         .then(() => res.json({ message: 'Token is valid' }))
//         .catch(next);
// }

// function resetPasswordSchema(req, res, next) {
//     const schema = Joi.object({
//         token: Joi.string().required(),
//         password: Joi.string().min(6).required(),
//         confirmPassword: Joi.string().valid(Joi.ref('password')).required()
//     });
//     validateRequest(req, next, schema);
// }

// function resetPassword(req, res, next) {
//     accountService.resetPassword(req.body)
//         .then(() => res.json({ message: 'Password reset successful, you can now login' }))
//         .catch(next);
// }

// function getAll(req, res, next) {
//     accountService.getAll()
//         .then(accounts => res.json(accounts))
//         .catch(next);
// }

// function getById(req, res, next) {
//     // users can get their own account and admins can get any account
//     // if (req.params.id !== req.user.id && req.user.role !== Role.Admin) {
//     //     return res.status(401).json({ message: 'Unauthorized' });
//     // }
//     accountService.getById(req.params.id)
//         .then(account => account ? res.json({ user: account }) : res.sendStatus(404))  // ✅ wrap it!
//         .catch(next);


// }

// function createSchema(req, res, next) {
//     const schema = Joi.object({
//         title: Joi.string().required(),
//         firstName: Joi.string().required(),
//         lastName: Joi.string().required(),
//         email: Joi.string().email().required(),
//         type: Joi.string().type().required(),
//         password: Joi.string().min(6).required(),
//         confirmPassword: Joi.string().valid(Joi.ref('password')).required(),
//         role: Joi.string().valid(Role.Admin, Role.User).required()
//     });
//     validateRequest(req, next, schema);
// }

// function create(req, res, next) {
//      // sanitize
//     req.body.firstName = sanitizeField(req.body.firstName);
//     req.body.lastName = sanitizeField(req.body.lastName);
//     req.body.type = sanitizeField(req.body.type);
//     accountService.create(req.body)
//         .then(account => res.json(account))
//         .catch(next);
// }

// function updateSchema(req, res, next) {
//     const schema = Joi.object({
//         email: Joi.string().email().empty(''),
//         title: Joi.string().empty(''),
//         firstName: Joi.string().empty(''),
//         lastName: Joi.string().empty(''),
//         password: Joi.string().min(6).empty(''),
//         confirmPassword: Joi.string().valid(Joi.ref('password')).empty(''),
//         gender: Joi.string().valid('Male', 'Female', 'Non-binary').empty(''),
//         type: Joi.string().empty(''),
//         bio: Joi.string().allow('', null),
//         graduationYear: Joi.string().allow('', null),
//         fieldOfStudy: Joi.string().allow('', null),
//         currentRole: Joi.string().allow('', null),
//         industry: Joi.string().allow('', null),
//         linkedIn: Joi.string().uri().allow('', null),
//         funFact: Joi.string().allow('', null),
//         rship: Joi.string().valid('Single', 'Married', 'Dating', 'It’s complicated', 'Prefer not to say').allow('', null),
//         phone: Joi.string().allow('', null),
//         origin: Joi.string().allow('', null),
//         nickname: Joi.string().allow('', null),
//         DOB: Joi.date().allow(null),
//         languages: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()),
//         interests: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()),
//         photos: Joi.array().items(Joi.string()).optional()
//     }).with('password', 'confirmPassword');

//     validateRequest(req, next, schema);
// }




// function update(req, res, next) {
//     if (req.params.id !== req.user.id && req.user.role !== Role.Admin) {
//         return res.status(401).json({ message: 'Unauthorized' });
//     }

//     if (req.body.interests && typeof req.body.interests === 'string') {
//         try {
//             req.body.interests = JSON.parse(req.body.interests);
//         } catch (err) {
//             return res.status(400).json({ message: 'Invalid interests format' });
//         }
//     }

//     // Sanitize free-text fields
//     const textFields = [
//         "firstName", "lastName", "nickname", "bio",
//         "funFact", "currentRole", "industry",
//         "fieldOfStudy", "origin", "type",
//         "rship", "phone"
//     ];

//     textFields.forEach(field => {
//         if (req.body[field]) {
//             req.body[field] = sanitizeField(req.body[field]);
//         }
//     });

//     // Sanitize arrays
//     if (req.body.languages) req.body.languages = sanitizeArray(req.body.languages);
//     if (req.body.interests) req.body.interests = sanitizeArray(req.body.interests);


//     accountService.update(req.params.id, req.body)
//         .then(account => res.json({ user: account }))
//         .catch(next);
// }






// function _delete(req, res, next) {
//     // users can delete their own account and admins can delete any account
//     if (req.params.id !== req.user.id && req.user.role !== Role.Admin) {
//         return res.status(401).json({ message: 'Unauthorized' });
//     }

//     accountService.delete(req.params.id)
//         .then(() => res.json({ message: 'Account deleted successfully' }))
//         .catch(next);
// }

// // helper functions

// function randomTokenString() {
//     const crypto = require('crypto');
//     return crypto.randomBytes(40).toString('hex');
// }

// function setTokenCookie(res, token) {
//     // create cookie with refresh token that expires in 7 days
//     const cookieOptions = {
//         httpOnly: true,
//         expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
//     };
//     res.cookie('refreshToken', token, cookieOptions);
// }






