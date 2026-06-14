import express from 'express';
import path from 'path';
import { datastore } from './src/db/db_adapter';
import { signToken, verifyToken } from './src/db/token';
import { createServer as createViteServer } from 'vite';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // JSON request parsing
  app.use(express.json());

  // Authentication Middleware
  app.use((req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      if (decoded) {
        req.user = decoded;
      }
    }
    next();
  });

  // Admin Verification helper
  const requireAdmin = (req: any, res: any, next: any) => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
    }
    next();
  };

  // Customer/User Verification helper
  const requireUser = (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    next();
  };

  // --- API ROUTES ---

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Auth: Login
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const user = datastore.verifyCredentials(email, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
    res.json({ user, token });
  });

  // Auth: Google / Third-party Mock login
  app.post('/api/auth/google', (req, res) => {
    const { email, name } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Google authentication payload incomplete.' });
    }
    
    let user = datastore.getUserByEmail(email);
    if (!user) {
      // Auto-register google user
      user = datastore.createUser(name, email, '', undefined);
    }
    
    const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
    res.json({ user, token });
  });

  // Auth: Register
  app.post('/api/auth/register', (req, res) => {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (datastore.getUserByEmail(email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const user = datastore.createUser(name, email, phone || '', password);
    const token = signToken({ id: user.id, name: user.name, email: user.email, role: user.role });
    res.status(210).json({ user, token });
  });

  // Auth: Get Profile
  app.get('/api/auth/profile', requireUser, (req: any, res) => {
    const user = datastore.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User profile not found.' });
    }
    res.json(user);
  });

  // Auth: Update Profile
  app.put('/api/auth/profile', requireUser, (req: any, res) => {
    const { name, phone, addresses } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    const updatedUser = datastore.updateUser(req.user.id, name, phone || '', addresses);
    res.json(updatedUser);
  });

  // Auth: Change Password
  app.put('/api/auth/password', requireUser, (req: any, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }
    const verified = datastore.verifyCredentials(req.user.email, currentPassword);
    if (!verified) {
      return res.status(401).json({ error: 'Incorrect current password.' });
    }
    datastore.updateUserPassword(req.user.id, newPassword);
    res.json({ message: 'Password changed successfully.' });
  });

  // Categories: Get categories
  app.get('/api/categories', (req, res) => {
    res.json(datastore.getCategories());
  });

  // Categories: Add category
  app.post('/api/categories', requireUser, requireAdmin, (req, res) => {
    const { id, name, icon, description } = req.body;
    if (!id || !name || !icon) {
      return res.status(400).json({ error: 'Id, name, and icon are required.' });
    }
    datastore.addCategory({ id, name, icon, description });
    res.status(201).json({ message: 'Category created successfully.', categories: datastore.getCategories() });
  });

  // Categories: Update category
  app.put('/api/categories/:id', requireUser, requireAdmin, (req, res) => {
    datastore.updateCategory(req.params.id, req.body);
    res.json({ message: 'Category updated successfully.', categories: datastore.getCategories() });
  });

  // Products: Get list (supports premium advanced filtering via query params)
  app.get('/api/products', (req, res) => {
    let result = datastore.getProducts();
    const { category, search, minPrice, maxPrice, rating, sort } = req.query;

    if (category && category !== 'all') {
      result = result.filter(p => p.category === category);
    }
    if (search) {
      const q = String(search).toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    }
    if (minPrice) {
      result = result.filter(p => p.price >= Number(minPrice));
    }
    if (maxPrice) {
      result = result.filter(p => p.price <= Number(maxPrice));
    }
    if (rating) {
      result = result.filter(p => p.rating >= Number(rating));
    }

    // Sort options
    if (sort === 'price-low-high') {
      result.sort((a, b) => a.price - b.price);
    } else if (sort === 'price-high-low') {
      result.sort((a, b) => b.price - a.price);
    } else if (sort === 'rating') {
      result.sort((a, b) => b.rating - a.rating);
    } else if (sort === 'popular') {
      result = result.filter(p => p.bestSeller || p.featured).concat(result.filter(p => !p.bestSeller && !p.featured));
    }

    res.json(result);
  });

  // Products: Add single product
  app.post('/api/products', requireUser, requireAdmin, (req, res) => {
    const { name, description, category, price, image, ingredients, nutrition, featured, bestSeller } = req.body;
    if (!name || !category || !price || !image) {
      return res.status(400).json({ error: 'Name, category, price, and image are required.' });
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(100+Math.random()*900);
    const newPrd = {
      id,
      name,
      description: description || '',
      category,
      price: Number(price),
      rating: 5.0,
      image,
      ingredients: ingredients || [],
      nutrition: nutrition || { calories: '0 kcal', protein: '0g', carbs: '0g', fats: '0g' },
      reviews: [],
      featured: !!featured,
      bestSeller: !!bestSeller
    };
    datastore.addProduct(newPrd);
    res.status(201).json(newPrd);
  });

  // Products: Update single product
  app.put('/api/products/:id', requireUser, requireAdmin, (req, res) => {
    datastore.updateProduct(req.params.id, req.body);
    const prd = datastore.getProductById(req.params.id);
    if (!prd) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json(prd);
  });

  // Products: Delete single product
  app.delete('/api/products/:id', requireUser, requireAdmin, (req, res) => {
    datastore.deleteProduct(req.params.id);
    res.json({ message: 'Product deleted successfully.' });
  });

  // Products: Add Review
  app.post('/api/products/:id/reviews', requireUser, (req: any, res) => {
    const { rating, comment } = req.body;
    if (!rating || !comment) {
      return res.status(400).json({ error: 'Rating and comment text are required.' });
    }
    const updatedPrd = datastore.addProductReview(req.params.id, req.user.name, req.user.email, Number(rating), comment);
    if (!updatedPrd) {
      return res.status(404).json({ error: 'Product not found to append review.' });
    }
    res.json(updatedPrd);
  });

  // Blogs: Get All Blogs
  app.get('/api/blogs', (req, res) => {
    res.json(datastore.getBlogs());
  });

  // Blogs: Get Single by ID
  app.get('/api/blogs/:id', (req, res) => {
    const blog = datastore.getBlogById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found.' });
    }
    res.json(blog);
  });

  // Blogs: Create blog
  app.post('/api/blogs', requireUser, requireAdmin, (req, res) => {
    const { title, content, summary, category, author, image, tags } = req.body;
    if (!title || !content || !image) {
      return res.status(400).json({ error: 'Title, content, and cover image are required.' });
    }
    const id = 'blog-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newBlog = {
      id,
      title,
      content,
      summary: summary || title,
      category: category || 'General',
      date: new Date().toISOString().split('T')[0],
      author: author || 'Dawat Masterchef',
      image,
      tags: tags || [],
      comments: []
    };
    datastore.addBlog(newBlog);
    res.status(201).json(newBlog);
  });

  // Blogs: Update blog
  app.put('/api/blogs/:id', requireUser, requireAdmin, (req, res) => {
    datastore.updateBlog(req.params.id, req.body);
    const blog = datastore.getBlogById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog post not found.' });
    }
    res.json(blog);
  });

  // Blogs: Delete blog
  app.delete('/api/blogs/:id', requireUser, requireAdmin, (req, res) => {
    datastore.deleteBlog(req.params.id);
    res.json({ message: 'Blog deleted successfully.' });
  });

  // Blogs: Add comment
  app.post('/api/blogs/:id/comments', requireUser, (req: any, res) => {
    const { comment } = req.body;
    if (!comment) {
      return res.status(400).json({ error: 'Comment content is required.' });
    }
    const blog = datastore.addBlogComment(req.params.id, req.user.name, comment);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found to comment.' });
    }
    res.json(blog);
  });

  // Orders: Create order
  app.post('/api/orders', (req, res) => {
    const {
      userId,
      customerName,
      customerEmail,
      customerPhone,
      items,
      subtotal,
      tax,
      deliveryFee,
      promoDiscount,
      total,
      address,
      deliveryInstructions,
      preferredDeliveryTime,
      paymentMethod
    } = req.body;

    if (!customerName || !customerEmail || !customerPhone || !items || items.length === 0 || !address || !address.houseNumber || !address.street || !address.area || !address.city) {
      return res.status(400).json({ error: 'Required order parameter or address structure is missing.' });
    }

    const order = datastore.createOrder({
      userId: userId || 'guest',
      customerName,
      customerEmail,
      customerPhone,
      items,
      subtotal: Number(subtotal),
      tax: Number(tax),
      deliveryFee: Number(deliveryFee),
      promoDiscount: Number(promoDiscount || 0),
      total: Number(total),
      address,
      deliveryInstructions: deliveryInstructions || '',
      preferredDeliveryTime: preferredDeliveryTime || 'As soon as possible',
      paymentMethod,
      paymentStatus: paymentMethod === 'Cash On Delivery' ? 'Pending' : 'Paid',
      status: 'Order Received'
    });

    res.status(201).json(order);
  });

  // Orders: Fetch User Specific Orders
  app.get('/api/orders/user/:userId', requireUser, (req, res) => {
    res.json(datastore.getUserOrders(req.params.userId));
  });

  // Orders: Fetch single order by order ID
  app.get('/api/orders/:id', (req, res) => {
    const ord = datastore.getOrderById(req.params.id);
    if (!ord) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    res.json(ord);
  });

  // Orders: Update order status (Admin/Staff only)
  app.put('/api/orders/:id/status', requireUser, requireAdmin, (req, res) => {
    const { status, paymentStatus } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'Status is required.' });
    }
    const updatedOrder = datastore.updateOrderStatus(req.params.id, status, paymentStatus);
    if (!updatedOrder) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    res.json(updatedOrder);
  });

  // Admin routes

  // Fetch all orders
  app.get('/api/admin/orders', requireUser, requireAdmin, (req, res) => {
    res.json(datastore.getOrders().sort((a,b) => b.date.localeCompare(a.date)));
  });

  // Fetch dashboard stats
  app.get('/api/admin/stats', requireUser, requireAdmin, (req, res) => {
    res.json(datastore.getStats());
  });

  // Fetch customer lists
  app.get('/api/admin/customers', requireUser, requireAdmin, (req, res) => {
    res.json(datastore.getUsers().filter(u => u.role !== 'admin'));
  });

  // Serve generated images directory
  app.use('/src/assets/images', express.static(path.join(process.cwd(), 'src/assets/images')));

  // --- VITE MIDDLEWARE INTERACTION (VITE AS EXPRESS MIDDLEWARE) ---

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[DAWAT FULLSTACK RUNNING] Server started on http://0.0.0.0:${PORT}`);
  });
}

startServer();
