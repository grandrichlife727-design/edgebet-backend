require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Redis = require("redis");
const Stripe = require("stripe");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json());

// Initialize Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Redis client
const redis = Redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379"
});
redis.connect().catch(console.error);

// OAuth Config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://grandrichlife727-design.github.io/edgebet-ai";

// Membership Tiers
const TIERS = {
  FREE: {
    name: 'Free',
    picksPerDay: 2,
    features: ['basic_picks', 'ev_calculator', 'journal'],
    price: 0,
    stripePriceId: null
  },
  PRO: {
    name: 'Pro',
    picksPerDay: 999,
    features: ['all_picks', 'ev_calculator', 'parlay_builder', 'line_shopping', 'journal', 'steam_moves', 'analytics'],
    price: 1999,
    stripePriceId: process.env.STRIPE_PRICE_PRO
  },
  SHARP: {
    name: 'Sharp',
    picksPerDay: 999,
    features: ['all_picks', 'ev_calculator', 'parlay_builder', 'line_shopping', 'journal', 'steam_moves', 'analytics', 'weather', 'arb_alerts', 'discord_access', 'priority_support'],
    price: 4999,
    stripePriceId: process.env.STRIPE_PRICE_SHARP
  }
};

// Data stores
const users = new Map();
const oauthStates = new Map();

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  
  const userId = token.replace('token_', '');
  const user = users.get(userId);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  
  req.user = user;
  next();
}

// ── GOOGLE OAUTH ──────────────────────────────────────────────────────────────
app.get('/auth/google/url', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }
  
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider: 'google', createdAt: Date.now() });
  
  // Clean old states after 10 minutes
  setTimeout(() => oauthStates.delete(state), 600000);
  
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${req.protocol}://${req.get('host')}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
    prompt: 'select_account'
  });
  
  res.json({
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state
  });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  
  if (error) {
    return res.redirect(`${FRONTEND_URL}/?auth=error&message=${encodeURIComponent(error)}`);
  }
  
  if (!oauthStates.has(state)) {
    return res.redirect(`${FRONTEND_URL}/?auth=error&message=Invalid state`);
  }
  
  oauthStates.delete(state);
  
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${req.protocol}://${req.get('host')}/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    
    const tokenData = await tokenRes.json();
    
    if (!tokenRes.ok) {
      throw new Error(tokenData.error_description || 'Token exchange failed');
    }
    
    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    
    const googleUser = await userRes.json();
    
    // Find or create user
    let user = Array.from(users.values()).find(u => u.email === googleUser.email);
    
    if (!user) {
      const userId = `user_google_${Date.now()}`;
      user = {
        id: userId,
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
        provider: 'google',
        tier: 'FREE',
        picksToday: 0,
        picksResetAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        onboardingCompleted: false
      };
      users.set(userId, user);
      
      // Create Stripe customer
      try {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name,
          metadata: { provider: 'google' }
        });
        user.stripeCustomerId = customer.id;
      } catch (e) {
        console.error('Stripe customer creation failed:', e.message);
      }
    }
    
    // Generate token
    const token = `token_${user.id}`;
    
    // Redirect to frontend with token
    res.redirect(`${FRONTEND_URL}/?auth=success&token=${token}&userId=${user.id}&email=${encodeURIComponent(user.email)}&onboarding=${!user.onboardingCompleted}`);
    
  } catch (e) {
    console.error('Google auth error:', e);
    res.redirect(`${FRONTEND_URL}/?auth=error&message=${encodeURIComponent(e.message)}`);
  }
});

// ── FACEBOOK OAUTH ───────────────────────────────────────────────────────────
app.get('/auth/facebook/url', (req, res) => {
  if (!FACEBOOK_APP_ID) {
    return res.status(500).json({ error: 'Facebook OAuth not configured' });
  }
  
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider: 'facebook', createdAt: Date.now() });
  
  setTimeout(() => oauthStates.delete(state), 600000);
  
  const params = new URLSearchParams({
    client_id: FACEBOOK_APP_ID,
    redirect_uri: `${req.protocol}://${req.get('host')}/auth/facebook/callback`,
    response_type: 'code',
    scope: 'email,public_profile',
    state: state
  });
  
  res.json({
    url: `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`,
    state
  });
});

app.get('/auth/facebook/callback', async (req, res) => {
  const { code, state, error } = req.query;
  
  if (error) {
    return res.redirect(`${FRONTEND_URL}/?auth=error&message=${encodeURIComponent(error)}`);
  }
  
  if (!oauthStates.has(state)) {
    return res.redirect(`${FRONTEND_URL}/?auth=error&message=Invalid state`);
  }
  
  oauthStates.delete(state);
  
  try {
    // Exchange code for token
    const tokenRes = await fetch('https://graph.facebook.com/v18.0/oauth/access_token', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const tokenUrl = `https://graph.facebook.com/v18.0/oauth/access_token?${new URLSearchParams({
      client_id: FACEBOOK_APP_ID,
      client_secret: FACEBOOK_APP_SECRET,
      redirect_uri: `${req.protocol}://${req.get('host')}/auth/facebook/callback`,
      code
    })}`;
    
    const tokenData = await (await fetch(tokenUrl)).json();
    
    if (tokenData.error) {
      throw new Error(tokenData.error.message);
    }
    
    // Get user info
    const userRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${tokenData.access_token}`);
    const fbUser = await userRes.json();
    
    // Find or create user
    let user = Array.from(users.values()).find(u => u.email === fbUser.email);
    
    if (!user) {
      const userId = `user_facebook_${Date.now()}`;
      user = {
        id: userId,
        email: fbUser.email,
        name: fbUser.name,
        picture: fbUser.picture?.data?.url,
        provider: 'facebook',
        tier: 'FREE',
        picksToday: 0,
        picksResetAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        onboardingCompleted: false
      };
      users.set(userId, user);
      
      try {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name,
          metadata: { provider: 'facebook' }
        });
        user.stripeCustomerId = customer.id;
      } catch (e) {
        console.error('Stripe customer creation failed:', e.message);
      }
    }
    
    const token = `token_${user.id}`;
    
    res.redirect(`${FRONTEND_URL}/?auth=success&token=${token}&userId=${user.id}&email=${encodeURIComponent(user.email)}&onboarding=${!user.onboardingCompleted}`);
    
  } catch (e) {
    console.error('Facebook auth error:', e);
    res.redirect(`${FRONTEND_URL}/?auth=error&message=${encodeURIComponent(e.message)}`);
  }
});

// ── EMAIL/PASSWORD AUTH ──────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  // Check if email exists
  const existing = Array.from(users.values()).find(u => u.email === email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  
  const userId = `user_${Date.now()}`;
  const user = {
    id: userId,
    email,
    name: name || email.split('@')[0],
    password: password, // Hash in production!
    provider: 'email',
    tier: 'FREE',
    picksToday: 0,
    picksResetAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    onboardingCompleted: false
  };
  
  users.set(userId, user);
  
  try {
    const customer = await stripe.customers.create({ email, name: user.name });
    user.stripeCustomerId = customer.id;
  } catch (e) {
    console.error('Stripe customer creation failed:', e.message);
  }
  
  res.json({
    userId,
    email,
    token: `token_${userId}`,
    tier: 'FREE',
    onboardingRequired: true
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = Array.from(users.values()).find(u => 
    u.email === email && u.password === password
  );
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  res.json({
    userId: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    token: `token_${user.id}`,
    tier: user.tier,
    onboardingCompleted: user.onboardingCompleted
  });
});

// ── TIER & SUBSCRIPTION ──────────────────────────────────────────────────────
async function getUserTier(userId) {
  const user = users.get(userId);
  if (!user) return 'FREE';
  
  if (user.subscriptionId && user.subscriptionStatus === 'active') {
    if (user.subscriptionCurrentPeriodEnd && new Date(user.subscriptionCurrentPeriodEnd) > new Date()) {
      return user.tier;
    }
  }
  
  return 'FREE';
}

app.get('/tier/status', authMiddleware, async (req, res) => {
  const tier = await getUserTier(req.user.id);
  const tierConfig = TIERS[tier.toUpperCase()];
  
  res.json({
    tier,
    features: tierConfig.features,
    picksPerDay: tierConfig.picksPerDay,
    picksUsedToday: req.user.picksToday || 0,
    picksRemaining: tierConfig.picksPerDay - (req.user.picksToday || 0),
    price: tierConfig.price,
    canUpgrade: tier !== 'SHARP',
    trialAvailable: !req.user.trialUsed
  });
});

// ── STRIPE CHECKOUT ───────────────────────────────────────────────────────────
app.post('/stripe/checkout', authMiddleware, async (req, res) => {
  const { tier } = req.body;
  const tierConfig = TIERS[tier.toUpperCase()];
  
  if (!tierConfig || tier === 'FREE' || !tierConfig.stripePriceId) {
    return res.status(400).json({ error: 'Invalid tier' });
  }
  
  try {
    const user = req.user;
    
    const sessionConfig = {
      customer: user.stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{
        price: tierConfig.stripePriceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/cancel`
    };
    
    // Add trial for new subscribers
    if (!user.trialUsed) {
      sessionConfig.subscription_data = {
        trial_period_days: 7
      };
    }
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    res.json({ sessionId: session.id, url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stripe webhook
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      const user = Array.from(users.values()).find(u => u.stripeCustomerId === session.customer);
      
      if (user) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = subscription.items.data[0].price.id;
        
        const tier = priceId === TIERS.PRO.stripePriceId ? 'PRO' : 
                     priceId === TIERS.SHARP.stripePriceId ? 'SHARP' : 'FREE';
        
        user.subscriptionId = session.subscription;
        user.subscriptionStatus = 'active';
        user.subscriptionCurrentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
        user.tier = tier;
        user.trialUsed = true;
        
        // Notify Discord
        if (process.env.DISCORD_WEBHOOK_URL) {
          await fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `🎉 New ${tier} subscriber: ${user.email} (${user.provider || 'email'})`
            })
          });
        }
      }
      break;
      
    case 'invoice.payment_failed':
      const sub = event.data.object;
      const failedUser = Array.from(users.values()).find(u => u.subscriptionId === sub.id);
      if (failedUser) {
        failedUser.tier = 'FREE';
        failedUser.subscriptionStatus = 'past_due';
      }
      break;
  }
  
  res.json({ received: true });
});

// ── PICKS (WITH LIMITS) ───────────────────────────────────────────────────────
app.get('/scan', authMiddleware, async (req, res) => {
  const user = req.user;
  const tier = await getUserTier(user.id);
  const tierConfig = TIERS[tier.toUpperCase()];
  
  // Reset daily counter if needed
  const lastReset = new Date(user.picksResetAt || 0);
  const now = new Date();
  if (lastReset.getDate() !== now.getDate() || lastReset.getMonth() !== now.getMonth()) {
    user.picksToday = 0;
    user.picksResetAt = now.toISOString();
  }
  
  if (user.picksToday >= tierConfig.picksPerDay) {
    return res.status(403).json({
      error: 'Daily pick limit reached',
      limit: tierConfig.picksPerDay,
      used: user.picksToday,
      upgradeUrl: '/upgrade',
      message: tier === 'FREE' ? 'Upgrade to Pro for unlimited picks' : 'Daily limit reached'
    });
  }
  
  user.picksToday++;
  
  // Return mock picks (integrate real odds API in production)
  res.json({
    picks: [
      { id: 1, bet: 'Lakers -4.5', odds: '-110', edge: 5.2, confidence: 72, sport: 'NBA' },
      { id: 2, bet: 'Chiefs ML', odds: '+150', edge: 3.8, confidence: 65, sport: 'NFL' }
    ],
    remainingPicks: tierConfig.picksPerDay - user.picksToday
  });
});

// ── ONBOARDING ─────────────────────────────────────────────────────────────────
app.post('/onboarding/complete', authMiddleware, (req, res) => {
  const user = req.user;
  user.onboardingCompleted = true;
  user.preferences = req.body;
  res.json({ success: true });
});

// ── BASE ───────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'EdgeBet AI v5.1',
  features: ['google_oauth', 'facebook_oauth', 'email_auth', 'tiers', 'subscriptions'],
  oauth: {
    google: !!GOOGLE_CLIENT_ID,
    facebook: !!FACEBOOK_APP_ID
  },
  version: '5.1.0'
}));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`EdgeBet AI v5.1 on :${PORT}`);
  console.log(`OAuth providers: Google=${!!GOOGLE_CLIENT_ID}, Facebook=${!!FACEBOOK_APP_ID}`);
  console.log(`Stripe: ${!!process.env.STRIPE_SECRET_KEY}`);
});
