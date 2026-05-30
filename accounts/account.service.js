

const config = require('config.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Account = require('./account.model');
const sendEmail = require('_helpers/send-email');
const Token = require('./token.model'); // adjust path if needed
const Role = require('_helpers/role');


function hash(password) {
    return bcrypt.hashSync(password, 10);
}
function generateJwtToken(account) {
    return jwt.sign(
        { sub: account.id, id: account.id },
        config.JWT_SECRET,
        { expiresIn: '30d' }
    );
}

module.exports = {
    authenticate,
    refreshToken,
    revokeToken,
    register,
    verifyEmail,
    resendOTP,
    forgotPassword,
    validateResetToken,
    resetPassword,
    getAll,
    getById,
    getVerifiedUsers,
    create,
    update,
    delete: _delete,
    sendRecoveryOtp,
    verifyRecoveryOtp,
    dismissRecoveryReminder
};

async function authenticate({ email, password, ipAddress }) {
    // Try primary email first, then recovery email
    let account = await Account.findOne({ email });
    if (!account) {
        account = await Account.findOne({ recoveryEmail: email, recoveryEmailVerified: true });
    }

    if (!account || !account.isVerified || !(await bcrypt.compare(password, account.passwordHash))) {
        throw 'Email or password is incorrect';
    }

    // Generate JWT token and refresh token
    const jwtToken = generateJwtToken(account);
    const refreshToken = generateRefreshToken(account, ipAddress);

    // Save refresh token
    await refreshToken.save();

    return {
        ...basicDetails(account),
        jwtToken,
        refreshToken: refreshToken.token
    };
}



async function refreshToken({ token, ipAddress }) {
    // implement your refresh logic here if needed
    throw 'Not implemented';
}

async function revokeToken({ token, ipAddress }) {
    // implement your revoke logic here if needed
    throw 'Not implemented';
}

async function register(params, origin) {
  const email = params.email.toLowerCase().trim();
  const existing = await Account.findOne({ email });

  // If already verified -> block re-register
  if (existing && existing.verified) {
    return { account: null, otpSent: false, reason: "ALREADY_VERIFIED" };
  }

  // If exists but not verified -> update details + resend OTP
  let account = existing;

  if (!account) {
    account = new Account({ ...params, email });
    const isFirstAccount = (await Account.countDocuments({})) === 0;
    account.role = isFirstAccount ? Role.Admin : Role.User;
    account.passwordHash = hash(params.password);
  } else {
    // Optional: allow updating name/gender/type while pending verification
    account.firstName = params.firstName;
    account.lastName = params.lastName;
    account.gender = params.gender;
    account.type = params.type;

    // Optional: if they re-register with a new password before verification
    if (params.password) account.passwordHash = hash(params.password);
  }

  // Always generate a fresh OTP
  account.verificationToken = generateResetCode();
  account.verificationTokenExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await account.save();

  // Try to send OTP email with retry logic (do not fail registration if SMTP fails)
  let otpSent = true;
  try {
    await sendVerificationEmailWithRetry(account, origin);
    console.log(`✅ Verification email sent to ${account.email}`);
  } catch (err) {
    otpSent = false;
    console.error("❌ OTP email failed after retries:", err?.message || err);
  }

  return { account, otpSent, reason: account === existing ? "RESENT" : "CREATED" };
}






async function verifyEmail({ token }) {
  const now = new Date();

  const account = await Account.findOne({
    verificationToken: token,
    verificationTokenExpires: { $gt: now },
  });

  if (!account) throw 'Verification failed or token expired';

  // ✅ mark verified
  account.verified = now;
  account.verificationToken = undefined;
  account.verificationTokenExpires = undefined;

  await account.save();

  // ✅ Send welcome email once (do NOT block verification if email fails)
  if (!account.welcomeEmailSent) {
    try {
      console.log('📧 Sending welcome email to:', account.email);

      await sendWelcomeEmail(account);

      account.welcomeEmailSent = true;
      await account.save();

      console.log('✅ Welcome email sent + flagged');
    } catch (err) {
      console.error('❌ Welcome email failed:', err?.message || err);
      // don't throw
    }
  }
}

/**
 * Resend OTP to user for verification
 * Modern implementation with better error handling and rate limiting
 */
async function resendOTP({ email }, origin) {
  try {
    const account = await Account.findOne({ email: email.toLowerCase().trim() });
    
    if (!account) {
      throw 'Email not found';
    }

    if (account.verified) {
      throw 'Account already verified. Please login.';
    }

    // Check if user is requesting OTP too frequently (rate limiting)
    const lastOtpTime = account.lastOtpRequestedAt || new Date(0);
    const timeSinceLastOtp = Date.now() - lastOtpTime.getTime();
    const MIN_TIME_BETWEEN_OTP = 30 * 1000; // 30 seconds

    if (timeSinceLastOtp < MIN_TIME_BETWEEN_OTP) {
      const retryAfter = Math.ceil((MIN_TIME_BETWEEN_OTP - timeSinceLastOtp) / 1000);
      throw `Please wait ${retryAfter} seconds before requesting another OTP`;
    }

    // Generate new OTP
    account.verificationToken = generateResetCode();
    account.verificationTokenExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    account.lastOtpRequestedAt = new Date();
    await account.save();

    // Send OTP email with retry logic
    await sendVerificationEmailWithRetry(account, origin);

    return {
      success: true,
      message: 'OTP sent successfully',
      email: account.email
    };
  } catch (error) {
    console.error('❌ Resend OTP error:', error?.message || error);
    throw error;
  }
}

/**
 * Send verification email with retry logic
 */
async function sendVerificationEmailWithRetry(account, origin, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await sendVerificationEmail(account, origin);
      console.log(`✅ Verification email sent on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      if (attempt <= retries) {
        // Exponential backoff: wait 1s, then 2s
        const waitTime = Math.pow(2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
}






async function forgotPassword({ email }, origin) {
    try {
        const account = await Account.findOne({ email: email.toLowerCase().trim() });
        if (!account) {
            // Don't reveal if email exists for security
            console.log(`Forgot password request for non-existent email: ${email}`);
            return { success: true, message: 'If email exists, a reset link has been sent' };
        }

        // Create new 6-digit code as reset token
        const resetCode = generateResetCode();
        account.resetToken = {
            token: resetCode,
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000) // expires in 24h
        };

        await account.save();

        // Send email with retry logic
        await sendPasswordResetEmailWithRetry(account, origin);

        return { success: true, message: 'Password reset instructions sent' };
    } catch (error) {
        console.error('❌ Forgot password error:', error?.message || error);
        throw error;
    }
}

/**
 * Send password reset email with retry logic
 */
async function sendPasswordResetEmailWithRetry(account, origin, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await sendPasswordResetEmail(account, origin);
      console.log(`✅ Password reset email sent on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      if (attempt <= retries) {
        // Exponential backoff: wait 1s, then 2s
        const waitTime = Math.pow(2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
}

async function sendWelcomeEmail(account) {
  const name = account.firstName ? ` ${account.firstName}` : '';
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color:#222;">
      <h2 style="color:#581845;">Hi${name} 🎉</h2>

      <p>Welcome to 34th Street.</p>

      <p>You’re officially part of a private, verified community of African professionals from top schools across the globe.</p>

      <p>Take a moment to complete your profile, explore the chat rooms, discover and connect with people from other schools/programs, and join conversations that speak to you.</p>

      <p><em>As we say back home, “the road opens when you begin to walk.”</em></p>

      <p style="margin-top:18px;">Warmly,<br/>See you on the Street!!!</p>

      <hr style="margin:16px 0; border:none; border-top:1px solid #eee;" />

      <p style="font-size: 14px; color:#555;">
        Need help? Visit Support:
        <a href="https://34thstreet.net/app-support/">34thstreet.net/app-support</a>
      </p>
    </div>
  `;

  await sendEmail({
    to: account.email,
    subject: 'Welcome to 34th Street 🎉',
    html,
    // optional but helpful for deliverability:
    text: `Hi${name}! Welcome to 34th Street. Support: https://34thstreet.net/app-support/`,
  });
}




//
async function validateResetToken({ token }) {
    const account = await Account.findOne({ 'resetToken.token': token });
    if (!account || account.resetToken.expires < Date.now()) throw 'Invalid token';
}




async function resetPassword({ token, password }) {
    const account = await Account.findOne({ 'resetToken.token': token });
    if (!account || account.resetToken.expires < Date.now()) throw 'Invalid token';

    account.passwordHash = bcrypt.hashSync(password, 10);
    account.passwordReset = Date.now();
    account.resetToken = undefined;
    await account.save();
}

async function getAll() {
    const accounts = await Account.find();
    return accounts.map(x => basicDetails(x));
}

async function getById(id) {
    const account = await Account.findById(id);
    if (!account) throw 'Account not found';
    return account; // ✅ Return full account data
}

async function getVerifiedUsers() {
    const accounts = await Account.find({ verified: { $ne: null } });
    return accounts.map(x => basicDetails(x));
}
async function create(params) {
    // 👇 Check if email exists
    if (await db.Account.findOne({ email: params.email })) {
        throw 'Email "' + params.email + '" is already registered';
    }

    const account = new Account(params);

    // 👇 Very important: hash the password before saving!
    if (params.password) {
        account.passwordHash = await bcrypt.hash(params.password, 10);
    }

    // 👇 Do not save the raw password
    delete account.password;

    await account.save();

    // Optional: create refresh token, etc.
    return basicDetails(account);
}

async function update(id, params) {
  const account = await Account.findById(id);
  if (!account) throw 'Account not found';

  // Convert stringified interests to array
  if (typeof params.interests === 'string') {
    try {
      params.interests = JSON.parse(params.interests);
    } catch (err) {
      console.error('❌ Failed to parse interests:', err.message);
      params.interests = [];
    }
  }

  // ✅ Whitelist fields that users are allowed to update
  const allowed = [
    'title', 'firstName', 'lastName', 'nickname', 'phone', 'origin',
    'bio', 'interests', 'photos', 'languages', 'fieldOfStudy', 'degreeField',
    'graduationYear', 'industry', 'currentRole', 'linkedIn', 'funFact',
    'rship', 'DOB',
    // ✅ location fields
    'currentCity', 'locationUpdatedAt', 'locationSharingEnabled',
    // ✅ school identity fields (needed for school-not-listed + alumni users)
    'schoolName', 'schoolGraduatedFrom',
  ];

  for (const key of allowed) {
    if (key in params) {
      // Never overwrite an existing DOB with null/empty — omit DOB from the
      // payload instead of clearing it if the client has no value to send.
      if (key === 'DOB' && !params[key] && account[key]) continue;
      account[key] = params[key];
    }
  }

  account.updated = new Date();
  await account.save();

  return basicDetails(account);
}




async function _delete(id) {
    await Account.findByIdAndDelete(id);
}

// ⚙️ Helper Functions



function generateRefreshToken(account, ipAddress) {
    return new Token({
        account: account.id,
        token: randomTokenString(),
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdByIp: ipAddress
    });
}

function randomTokenString() {
    return crypto.randomBytes(40).toString('hex');
}

function basicDetails(account) {

    const {
        id, title, firstName, lastName, email, gender, type,
        phone, origin, bio, interests, photos, created, updated, verified,
        nickname, DOB, languages, fieldOfStudy, degreeField, graduationYear,
        industry, currentRole, linkedIn, funFact, rship, currentCity,
    locationUpdatedAt, locationSharingEnabled,
    // School fields
    schoolGraduatedFrom, schoolName,
    // 🔴 Presence fields
    onlineStatus, lastSeen, lastActivity,
    // Recovery email
    recoveryEmail, recoveryEmailVerified, recoveryEmailDismissedAt,

    } = account;

      const share = locationSharingEnabled !== false;


    return {
        id, title, firstName, lastName, email, gender, type,
        phone, origin, bio, interests, photos, created, updated, verified,
        nickname, DOB, languages, fieldOfStudy, degreeField, graduationYear,
        industry, currentRole, linkedIn, funFact, rship, currentCity,
    locationUpdatedAt, locationSharingEnabled,
    // School fields
    schoolGraduatedFrom: schoolGraduatedFrom || null,
    schoolName: schoolName || null,
    currentCity: share ? (currentCity || '') : '',
    locationUpdatedAt: share ? locationUpdatedAt : null,
    // 🔴 Include presence fields in API response
    onlineStatus: onlineStatus || 'offline',
    lastSeen: lastSeen || null,
    lastActivity: lastActivity || null,
    // Recovery email
    recoveryEmail: recoveryEmail || null,
    recoveryEmailVerified: recoveryEmailVerified || false,
    recoveryEmailDismissedAt: recoveryEmailDismissedAt || null,

    };
    
}




async function sendVerificationEmail(account, origin) {
    let message;
    if (origin) {
        const verifyUrl = `${origin}/verify-email?token=${account.verificationToken}`;
        message = `
          <div style="background: white; padding: 20px; border-radius: 4px;">
            <p>Thanks for registering! Please use the code below to verify your email:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 4px; text-align: center; margin: 20px 0;">
              <h1 style="color: #581845; letter-spacing: 4px; font-family: monospace; margin: 0;">${account.verificationToken}</h1>
            </div>
            <p>Or click the link below:</p>
            <p><a href="${verifyUrl}" style="background: #581845; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Verify Email</a></p>
          </div>
        `;
    } else {
        message = `<div style="background: white; padding: 20px; border-radius: 4px;"><p>Use this code to verify your email:</p><h1 style="color: #581845; letter-spacing: 4px; font-family: monospace; text-align: center;">${account.verificationToken}</h1></div>`;
    }

    await sendEmail({
        to: account.email,
        subject: 'Verify Your Email - 34th Street',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                <h2 style="margin: 0;">Verify Your Email</h2>
              </div>
              ${message}
              <div style="background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666;">
                <p>This code expires in 10 minutes</p>
                <p style="margin: 10px 0 0 0;">© 2024 34th Street. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `
    });
}

async function sendPasswordResetEmail(account, origin) {
    let message;
    if (origin) {
        const resetUrl = `${origin}/reset-password?token=${account.resetToken.token}`;
        message = `
          <div style="background: white; padding: 20px; border-radius: 4px;">
            <p>Someone (hopefully you) requested a password reset. Use the code below to reset your password:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 4px; text-align: center; margin: 20px 0;">
              <h1 style="color: #581845; letter-spacing: 4px; font-family: monospace; margin: 0;">${account.resetToken.token}</h1>
            </div>
            <p>Or click the link below:</p>
            <p><a href="${resetUrl}" style="background: #581845; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">Reset Password</a></p>
            <p style="color: #999; font-size: 12px;">If you didn't request this, please ignore this email.</p>
          </div>
        `;
    } else {
        message = `<div style="background: white; padding: 20px; border-radius: 4px;"><p>Use this code to reset your password:</p><h1 style="color: #581845; letter-spacing: 4px; font-family: monospace; text-align: center;">${account.resetToken.token}</h1></div>`;
    }

    await sendEmail({
        to: account.email,
        subject: 'Reset Your Password - 34th Street',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                <h2 style="margin: 0;">Reset Your Password</h2>
              </div>
              ${message}
              <div style="background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666;">
                <p>This code expires in 24 hours</p>
                <p style="margin: 10px 0 0 0;">© 2024 34th Street. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `
    });
}


function generateResetCode() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // Generates 6-digit string
}


// ─── Recovery Email OTP ───────────────────────────────────────

async function sendRecoveryOtp({ userId, recoveryEmail }) {
    const account = await Account.findById(userId);
    if (!account) throw 'Account not found';

    // Ensure recovery email is not already used as a primary email by another account
    const existing = await Account.findOne({ email: recoveryEmail });
    if (existing && String(existing._id) !== String(account._id)) {
        throw 'This email is already registered as a primary email';
    }

    // Check if another account already uses this as recovery email
    const existingRecovery = await Account.findOne({
        recoveryEmail,
        recoveryEmailVerified: true,
        _id: { $ne: account._id }
    });
    if (existingRecovery) {
        throw 'This email is already used as a recovery email by another account';
    }

    // Rate limit: 30 seconds
    if (account.recoveryOtpExpires && account.recoveryOtp) {
        const timeSinceSent = Date.now() - (account.recoveryOtpExpires.getTime() - 10 * 60 * 1000);
        if (timeSinceSent < 30000) {
            const waitSec = Math.ceil((30000 - timeSinceSent) / 1000);
            throw `Please wait ${waitSec} seconds before requesting another OTP`;
        }
    }

    const otp = generateResetCode();
    account.recoveryOtp = otp;
    account.recoveryOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    account.recoveryEmail = recoveryEmail;
    account.recoveryEmailVerified = false;
    await account.save();

    // Send OTP to recovery email
    await sendEmail({
        to: recoveryEmail,
        subject: 'Verify Your Recovery Email - 34th Street',
        html: `
          <!DOCTYPE html>
          <html>
          <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                <h2 style="margin: 0;">Verify Recovery Email</h2>
              </div>
              <div style="background: white; padding: 20px; border-radius: 4px;">
                <p>Hi ${account.firstName},</p>
                <p>You're setting up <strong>${recoveryEmail}</strong> as your recovery email. Use the code below to verify:</p>
                <div style="background: #f5f5f5; padding: 20px; border-radius: 4px; text-align: center; margin: 20px 0;">
                  <h1 style="color: #581845; letter-spacing: 4px; font-family: monospace; margin: 0;">${otp}</h1>
                </div>
                <p style="color: #666; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, please ignore this email.</p>
              </div>
              <div style="background: #f5f5f5; padding: 15px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666;">
                <p style="margin: 0;">&copy; ${new Date().getFullYear()} 34th Street. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `
    });

    return { success: true, message: 'OTP sent to recovery email' };
}

async function verifyRecoveryOtp({ userId, otp }) {
    const account = await Account.findById(userId);
    if (!account) throw 'Account not found';

    if (!account.recoveryOtp || !account.recoveryOtpExpires) {
        throw 'No pending recovery email verification';
    }

    if (Date.now() > account.recoveryOtpExpires.getTime()) {
        account.recoveryOtp = null;
        account.recoveryOtpExpires = null;
        await account.save();
        throw 'OTP has expired. Please request a new one';
    }

    if (account.recoveryOtp !== otp) {
        throw 'Invalid OTP';
    }

    account.recoveryEmailVerified = true;
    account.recoveryOtp = null;
    account.recoveryOtpExpires = null;
    await account.save();

    return { success: true, message: 'Recovery email verified', user: basicDetails(account) };
}

async function dismissRecoveryReminder({ userId }) {
    const account = await Account.findById(userId);
    if (!account) throw 'Account not found';

    account.recoveryEmailDismissedAt = new Date();
    await account.save();

    return { success: true, user: basicDetails(account) };
}


// const config = require('config.json');
// const jwt = require('jsonwebtoken');
// const bcrypt = require('bcryptjs');
// const crypto = require('crypto');
// const Account = require('./account.model');
// const sendEmail = require('_helpers/send-email');
// const Token = require('./token.model'); // adjust path if needed
// const Role = require('_helpers/role');


// function hash(password) {
//     return bcrypt.hashSync(password, 10);
// }
// function generateJwtToken(account) {
//     return jwt.sign(
//         { sub: account.id, id: account.id },
//         config.JWT_SECRET,
//         { expiresIn: '7d' }
//     );
// }

// module.exports = {
//     authenticate,
//     refreshToken,
//     revokeToken,
//     register,
//     verifyEmail,
//     forgotPassword,
//     validateResetToken,
//     resetPassword,
//     getAll,
//     getById,
//     getVerifiedUsers,
//     create,
//     update,
//     delete: _delete
// };

// async function authenticate({ email, password, ipAddress }) {
//     const account = await Account.findOne({ email });

//     if (!account || !account.isVerified || !(await bcrypt.compare(password, account.passwordHash))) {
//         throw 'Email or password is incorrect';
//     }

//     // Generate JWT token and refresh token
//     const jwtToken = generateJwtToken(account);
//     const refreshToken = generateRefreshToken(account, ipAddress);

//     // Save refresh token
//     await refreshToken.save();

//     return {
//         ...basicDetails(account),
//         jwtToken,
//         refreshToken: refreshToken.token
//     };
// }



// async function refreshToken({ token, ipAddress }) {
//     // implement your refresh logic here if needed
//     throw 'Not implemented';
// }

// async function revokeToken({ token, ipAddress }) {
//     // implement your revoke logic here if needed
//     throw 'Not implemented';
// }

// async function register(params, origin) {
//     try {
//         const existingUser = await Account.findOne({ email: params.email })
//         if (existingUser) {
//             console.log("User already registered:", params.email);
//             return await sendAlreadyRegisteredEmail(params.email, origin);
//         }

//         const account = new Account(params);
//         const isFirstAccount = (await Account.countDocuments({})) === 0;
//         account.role = isFirstAccount ? Role.Admin : Role.User;

//         //  Generate 6-digit OTP and store it
//         account.verificationToken = Math.floor(100000 + Math.random() * 900000).toString();

//         // Hash password
//         account.passwordHash = hash(params.password);

//         // Save account
//         await account.save();

//         console.log(` User registered successfully: ${account.email}, OTP: ${account.verificationToken}`);

//         // Send verification email with the OTP
//         await sendVerificationEmail(account, origin);

//         //  Return the created user object
//         return account;

//     } catch (error) {
//         console.error(" Error registering user:", error);
//         throw new Error("User registration failed");
//     }

// }


// async function verifyEmail({ token }) {
//     const account = await Account.findOne({ verificationToken: token });
//     if (!account) throw 'Verification failed';
//     account.verified = Date.now();
//     account.verificationToken = undefined;
//     await account.save();
// }



// async function forgotPassword({ email }, origin) {
//     const account = await Account.findOne({ email });
//     if (!account) return;

//     // Invalidate any old token
//     account.resetToken = undefined;

//     // Create new 6-digit code as reset token
//     const resetCode = generateResetCode();
//     account.resetToken = {
//         token: resetCode,
//         expires: new Date(Date.now() + 24 * 60 * 60 * 1000) // expires in 24h
//     };

//     await account.save();

//     await sendPasswordResetEmail(account, origin);
// }




// //
// async function validateResetToken({ token }) {
//     const account = await Account.findOne({ 'resetToken.token': token });
//     if (!account || account.resetToken.expires < Date.now()) throw 'Invalid token';
// }




// async function resetPassword({ token, password }) {
//     const account = await Account.findOne({ 'resetToken.token': token });
//     if (!account || account.resetToken.expires < Date.now()) throw 'Invalid token';

//     account.passwordHash = bcrypt.hashSync(password, 10);
//     account.passwordReset = Date.now();
//     account.resetToken = undefined;
//     await account.save();
// }

// async function getAll() {
//     const accounts = await Account.find();
//     return accounts.map(x => basicDetails(x));
// }

// async function getById(id) {
//     const account = await Account.findById(id);
//     if (!account) throw 'Account not found';
//     return account; // ✅ Return full account data
// }

// async function getVerifiedUsers() {
//     const accounts = await Account.find({ verified: { $ne: null } });
//     return accounts.map(x => basicDetails(x));
// }
// async function create(params) {
//     // 👇 Check if email exists
//     if (await db.Account.findOne({ email: params.email })) {
//         throw 'Email "' + params.email + '" is already registered';
//     }

//     const account = new Account(params);

//     // 👇 Very important: hash the password before saving!
//     if (params.password) {
//         account.passwordHash = await bcrypt.hash(params.password, 10);
//     }

//     // 👇 Do not save the raw password
//     delete account.password;

//     await account.save();

//     // Optional: create refresh token, etc.
//     return basicDetails(account);
// }



// async function update(id, params) {
//     const account = await Account.findById(id);
//     if (!account) throw 'Account not found';

//     // 🧠 Convert stringified interests to array
//     if (typeof params.interests === 'string') {
//         try {
//             params.interests = JSON.parse(params.interests);
//         } catch (err) {
//             console.error('❌ Failed to parse interests:', err.message);
//             params.interests = [];
//         }
//     }

//     // 🔥 Update fields
//     Object.assign(account, {
//         ...params,
//         updated: new Date()
//     });

//     await account.save();

//     return account; // ✅ Return full updated object
// }

// async function _delete(id) {
//     await Account.findByIdAndDelete(id);
// }

// // ⚙️ Helper Functions

// // function generateJwtToken(account) {
// //     return jwt.sign({ id: account.id }, config.JWT_SECRET, { expiresIn: '7d' });
// // }

// function generateRefreshToken(account, ipAddress) {
//     return new Token({
//         account: account.id,
//         token: randomTokenString(),
//         expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
//         createdByIp: ipAddress
//     });
// }

// function randomTokenString() {
//     return crypto.randomBytes(40).toString('hex');
// }

// function basicDetails(account) {

//     const {
//         id, title, firstName, lastName, email, gender, type,
//         phone, origin, bio, interests, photos, created, updated, verified,
//         nickname, DOB, languages, fieldOfStudy, graduationYear,
//         industry, currentRole, linkedIn, funFact, rship
//     } = account;

//     return {
//         id, title, firstName, lastName, email, gender, type,
//         phone, origin, bio, interests, photos, created, updated, verified,
//         nickname, DOB, languages, fieldOfStudy, graduationYear,
//         industry, currentRole, linkedIn, funFact, rship
//     };
    
// }




// async function sendVerificationEmail(account, origin) {
//     let message;
//     if (origin) {
//         const verifyUrl = `${origin}/verify-email?token=${account.verificationToken}`;
//         message = `<p>Thanks for registering. Please click the link below to verify your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;
//     } else {
//         message = `<p>Use this token to verify your email: <strong>${account.verificationToken}</strong></p>`;
//     }

//     await sendEmail({
//         to: account.email,
//         subject: 'Verify Email',
//         html: `<h4>Verify Email</h4>${message}`
//     });
// }

// async function sendPasswordResetEmail(account, origin) {
//     let message;
//     if (origin) {
//         const resetUrl = `${origin}/reset-password?token=${account.resetToken.token}`;
//         message = `<p>Click the link below to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`;
//     } else {
//         message = `<p>Use this token to reset your password: <strong>${account.resetToken.token}</strong></p>`;
//     }

//     await sendEmail({
//         to: account.email,
//         subject: 'Reset Password',
//         html: `<h4>Reset Password</h4>${message}`
//     });
// }


// function generateResetCode() {
//     return Math.floor(100000 + Math.random() * 900000).toString(); // Generates 6-digit string
// }