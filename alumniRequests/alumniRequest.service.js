const bcrypt = require('bcryptjs');
const AlumniRequest = require('./alumniRequest.model');
const Account = require('../accounts/account.model');
const sendEmail = require('../_helpers/send-email');
const config = require('../config.js');

function hash(password) {
  return bcrypt.hashSync(password, 10);
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = {
  sendOtp,
  resendOtp,
  verifyOtp,
  submitRequest,
  getAll,
  getById,
  approve,
  deny,
  getStats,
};

// ─── OTP Flow ──────────────────────────────────────────

async function sendOtp({ personalEmail, firstName }) {
  const email = personalEmail.toLowerCase().trim();

  const existingAccount = await Account.findOne({ email });
  if (existingAccount && existingAccount.verified) {
    throw 'An account with this email already exists. Please login.';
  }

  const otp = generateOTP();
  const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

  let request = await AlumniRequest.findOne({ personalEmail: email, status: 'pending' });
  if (request) {
    request.otpToken = otp;
    request.otpExpires = otpExpires;
    await request.save();
  } else {
    request = new AlumniRequest({
      firstName: firstName || 'Pending',
      lastName: 'Pending',
      gender: 'Male',
      phone: 'pending',
      personalEmail: email,
      workEmail: null,
      schoolGraduatedFrom: 'pending',
      degreeHeld: 'pending',
      linkedIn: 'https://linkedin.com/in/pending',
      passwordHash: 'pending',
      otpToken: otp,
      otpExpires: otpExpires,
      personalEmailVerified: false,
    });
    await request.save();
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
        .header h2 { margin: 0; font-size: 24px; }
        .header p { margin: 8px 0 0 0; color: #ffb60a; font-size: 14px; }
        .content { background: white; padding: 30px; border: 1px solid #e0e0e0; }
        .otp-box { background: linear-gradient(135deg, #f5edf8 0%, #f0e6f0 100%); padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
        .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 6px; color: #581845; font-family: 'Courier New', monospace; }
        .footer { background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666; }
        p { line-height: 1.6; color: #333; }
        .warning { color: #666; font-size: 13px; margin: 15px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>34th Street</h2>
          <p>Alumni / Professional Verification</p>
        </div>
        <div class="content">
          <p>Hi${firstName ? ` ${firstName}` : ''},</p>
          <p>Thanks for requesting access to 34th Street as an alumni/professional. Your verification code is:</p>
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
          </div>
          <div class="warning">
            ⏱️ This code expires in 10 minutes<br/>
            🔒 Never share this code with anyone<br/>
            ❓ If you didn't request this, please ignore this email
          </div>
        </div>
        <div class="footer">
          <p>© 2024 34th Street. All rights reserved.</p>
          <p style="margin: 5px 0 0 0;">Need help? <a href="https://34thstreet.net/app-support/" style="color: #581845; text-decoration: none;">Visit our support center</a></p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    console.log(`📧 [AlumniRequest] Sending OTP to ${email}...`);
    await sendEmail({ to: email, subject: 'Your 34th Street Verification Code', html });
    console.log(`✅ [AlumniRequest] OTP email sent to ${email}`);
  } catch (err) {
    console.error(`❌ [AlumniRequest] Failed to send OTP:`, err.message);
  }

  return { message: 'OTP sent to your personal email. Check inbox/spam folder.', requestId: request.id };
}

async function verifyOtp({ personalEmail, otp }) {
  const email = personalEmail.toLowerCase().trim();
  const now = new Date();

  const request = await AlumniRequest.findOne({
    personalEmail: email,
    otpToken: otp,
    otpExpires: { $gt: now },
  });

  if (!request) throw 'Invalid or expired verification code.';

  request.personalEmailVerified = true;
  request.otpToken = undefined;
  request.otpExpires = undefined;
  await request.save();

  return { message: 'Email verified successfully', requestId: request.id, verified: true };
}

async function resendOtp({ personalEmail, firstName }) {
  const email = personalEmail.toLowerCase().trim();
  const request = await AlumniRequest.findOne({ personalEmail: email, status: 'pending' });

  if (!request) throw 'No pending verification request found for this email.';
  if (request.personalEmailVerified) throw 'Email already verified.';

  const lastOtpTime = request.lastOtpRequestedAt || new Date(0);
  const timeSinceLastOtp = Date.now() - lastOtpTime.getTime();
  if (timeSinceLastOtp < 30000) {
    const retryAfter = Math.ceil((30000 - timeSinceLastOtp) / 1000);
    throw `Please wait ${retryAfter} seconds before requesting another code.`;
  }

  const otp = generateOTP();
  const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

  request.otpToken = otp;
  request.otpExpires = otpExpires;
  request.lastOtpRequestedAt = new Date();
  await request.save();

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #581845 0%, #8B2E6C 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
        .header h2 { margin: 0; font-size: 24px; }
        .header p { margin: 8px 0 0 0; color: #ffb60a; font-size: 14px; }
        .content { background: white; padding: 30px; border: 1px solid #e0e0e0; }
        .otp-box { background: linear-gradient(135deg, #f5edf8 0%, #f0e6f0 100%); padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
        .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 6px; color: #581845; font-family: 'Courier New', monospace; }
        .footer { background: #f5f5f5; padding: 20px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666; }
        p { line-height: 1.6; color: #333; }
        .warning { color: #666; font-size: 13px; margin: 15px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>34th Street</h2>
          <p>Verification Code (Resent)</p>
        </div>
        <div class="content">
          <p>Hi${firstName ? ` ${firstName}` : ''},</p>
          <p>Here's your new verification code:</p>
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
          </div>
          <div class="warning">
            ⏱️ This code expires in 10 minutes<br/>
            🔒 Never share this code with anyone
          </div>
        </div>
        <div class="footer">
          <p>© 2024 34th Street. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await sendEmail({ to: email, subject: 'Your 34th Street Verification Code (Resent)', html });
  } catch (err) {
    console.error(`❌ [AlumniRequest] Failed to resend OTP:`, err.message);
  }

  return { message: 'New verification code sent.', requestId: request.id };
}

// ─── Submit Full Application ──────────────────────────

async function submitRequest(params) {
  const email = params.personalEmail.toLowerCase().trim();

  let request = await AlumniRequest.findOne({
    personalEmail: email,
    personalEmailVerified: true,
    status: 'pending',
  });

  if (!request) throw 'Please verify your personal email first before submitting.';

  // Only check workEmail uniqueness if provided
  if (params.workEmail && params.workEmail.trim()) {
    const existingWorkEmail = await Account.findOne({ email: params.workEmail.toLowerCase().trim() });
    if (existingWorkEmail && existingWorkEmail.verified) {
      throw 'An account with this work email already exists.';
    }
  }

  request.firstName = params.firstName;
  request.lastName = params.lastName;
  request.gender = params.gender;
  request.phone = params.phone;
  request.workEmail = params.workEmail ? params.workEmail.toLowerCase().trim() : null;
  request.schoolGraduatedFrom = params.schoolGraduatedFrom;
  request.degreeHeld = params.degreeHeld;
  request.graduationYear = params.graduationYear || null;
  request.linkedIn = params.linkedIn;
  request.passwordHash = hash(params.password);
  request.status = 'pending';

  await request.save();

  await sendSubmissionConfirmationEmail(request);

  return {
    message: 'Your application has been submitted successfully. Our team will review your profile within 3-5 working days.',
    requestId: request.id,
  };
}

// ─── Admin Queries ────────────────────────────────────

async function getAll({ status, page = 1, limit = 20, search } = {}) {
  const query = { firstName: { $ne: 'Pending' } };

  if (status && status !== 'all') query.status = status;
  if (search) {
    const regex = new RegExp(search, 'i');
    query.$or = [
      { firstName: regex },
      { lastName: regex },
      { personalEmail: regex },
      { workEmail: regex },
      { schoolGraduatedFrom: regex },
      { degreeHeld: regex },
    ];
  }

  const skip = (page - 1) * limit;
  const [requests, total] = await Promise.all([
    AlumniRequest.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('reviewedBy', 'firstName lastName email').lean(),
    AlumniRequest.countDocuments(query),
  ]);

  return { requests, total, page, pages: Math.ceil(total / limit) };
}

async function getById(id) {
  const request = await AlumniRequest.findById(id).populate('reviewedBy', 'firstName lastName email');
  if (!request) throw 'Request not found';
  return request;
}

async function getStats() {
  const [pending, approved, denied, total] = await Promise.all([
    AlumniRequest.countDocuments({ status: 'pending', firstName: { $ne: 'Pending' } }),
    AlumniRequest.countDocuments({ status: 'approved' }),
    AlumniRequest.countDocuments({ status: 'denied' }),
    AlumniRequest.countDocuments({ firstName: { $ne: 'Pending' } }),
  ]);
  return { pending, approved, denied, total };
}

// ─── Approve / Deny ───────────────────────────────────

async function approve(id, adminId) {
  const request = await AlumniRequest.findById(id);
  if (!request) throw 'Request not found';
  if (request.status !== 'pending') throw 'Request has already been processed';

  // Login email: prefer workEmail if provided, otherwise use personalEmail
  const loginEmail = (request.workEmail && request.workEmail !== 'pending@pending.com')
    ? request.workEmail
    : request.personalEmail;

  const existingAccount = await Account.findOne({ email: loginEmail });
  if (existingAccount && existingAccount.verified) {
    throw 'An account with this email already exists.';
  }

  let account = existingAccount;
  if (!account) {
    account = new Account({
      email: loginEmail,
      passwordHash: request.passwordHash,
      firstName: request.firstName,
      lastName: request.lastName,
      gender: request.gender,
      phone: request.phone,
      type: 'Alumni',
      role: 'User',
      verified: new Date(),
      // Alumni-specific profile data
      schoolGraduatedFrom: request.schoolGraduatedFrom,
      fieldOfStudy: request.degreeHeld,
      graduationYear: request.graduationYear || null,
      linkedIn: request.linkedIn,
    });
  } else {
    account.passwordHash = request.passwordHash;
    account.firstName = request.firstName;
    account.lastName = request.lastName;
    account.gender = request.gender;
    account.phone = request.phone;
    account.verified = new Date();
    account.schoolGraduatedFrom = request.schoolGraduatedFrom;
    account.fieldOfStudy = request.degreeHeld;
    account.graduationYear = request.graduationYear || account.graduationYear || null;
    account.linkedIn = request.linkedIn;
  }

  await account.save();

  request.status = 'approved';
  request.reviewedAt = new Date();
  request.reviewedBy = adminId;
  request.accountId = account._id;
  await request.save();

  await sendApprovalEmail(request);

  return { message: 'Request approved. Alumni account created and notification sent.', account: account.id };
}

async function deny(id, adminId, reason) {
  const request = await AlumniRequest.findById(id);
  if (!request) throw 'Request not found';
  if (request.status !== 'pending') throw 'Request has already been processed';

  request.status = 'denied';
  request.reviewedAt = new Date();
  request.reviewedBy = adminId;
  request.denialReason = reason || null;
  await request.save();

  await sendDenialEmail(request);

  return { message: 'Request denied. Notification sent to applicant.' };
}

// ─── Email Templates ──────────────────────────────────

async function sendSubmissionConfirmationEmail(request) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto;">
      <div style="background: #581845; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h2 style="color: #fff; margin: 0;">34th Street</h2>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <h3 style="color: #581845;">Your Alumni/Professional profile is being reviewed</h3>
        <p>Hi ${request.firstName},</p>
        <p>Thank you for your interest in joining 34th Street as an alumni/professional. We've received your application and our team will review your profile within <strong>3–5 working days</strong>.</p>
        <p>Once verified, you'll receive an email with instructions to activate your account.</p>
        <p style="margin-top: 24px;">Warm regards,<br/><strong>The 34th Street Team</strong></p>
        <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;" />
        <p style="font-size: 13px; color: #888;">Need help? Visit <a href="https://34thstreet.net/app-support/" style="color: #581845;">34thstreet.net/app-support</a></p>
      </div>
    </div>
  `;
  await sendEmail({ to: request.personalEmail, subject: 'Your 34th Street profile is being reviewed', html });
}

async function sendApprovalEmail(request) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto;">
      <div style="background: #581845; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h2 style="color: #fff; margin: 0;">34th Street</h2>
        <p style="color: #ffb60a; margin: 4px 0 0;">You're in!</p>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <h3 style="color: #581845;">Welcome to 34th Street</h3>
        <p>Hi ${request.firstName},</p>
        <p>Great news — your alumni/professional profile has been verified and you've been approved.</p>
        <p>You can now log in using your work email:</p>
        <div style="text-align: center; margin: 20px 0; padding: 16px; background: #f5edf8; border-radius: 8px;">
          <p style="margin: 0; font-size: 14px; color: #666;">Login Email</p>
          <p style="margin: 4px 0 0; font-size: 18px; font-weight: bold; color: #581845;">${request.workEmail}</p>
        </div>
        <p style="margin-top: 24px;">Welcome to 34th Street.<br/><strong>The 34th Street Team</strong></p>
      </div>
    </div>
  `;
  await sendEmail({ to: request.personalEmail, subject: "You're in — welcome to 34th Street", html });
}

async function sendDenialEmail(request) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto;">
      <div style="background: #581845; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h2 style="color: #fff; margin: 0;">34th Street</h2>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #eee; border-top: none; border-radius: 0 0 12px 12px;">
        <h3 style="color: #581845;">Update on your 34th Street application</h3>
        <p>Hi ${request.firstName},</p>
        <p>After reviewing your profile, we were unable to verify your identity at this time.</p>
        <p><strong>To strengthen your application:</strong></p>
        <ul style="color: #555; padding-left: 20px;">
          <li>Ensure your current or past school/employer is visible on your LinkedIn profile</li>
          <li>Set your LinkedIn profile visibility to public</li>
          <li>Verify your degree information is accurate</li>
        </ul>
        <p>You're welcome to reapply once your profile is updated.</p>
        <p>Questions? Email us at <a href="mailto:info@34thstreet.net" style="color: #581845;">info@34thstreet.net</a></p>
        <p style="margin-top: 24px;">The 34th Street Team</p>
      </div>
    </div>
  `;
  await sendEmail({ to: request.personalEmail, subject: 'Update on your 34th Street application', html });
}
