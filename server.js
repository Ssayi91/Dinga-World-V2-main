require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const CarModel = require('./models/car');
const BlogPost = require('./models/BlogPost');
const User = require('./models/User');
const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const EventEmitter = require('events');
const { checkAccess } = require("./middleware/roles");
const car = require('./models/car');
const app = express();
const PORT = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "default_secret_key";
const carEventEmitter = new EventEmitter();

const saltRounds = 10;


app.use(cors());
app.use(express.json());
app.use(cookieParser()); // Middleware to parse cookies

// Middleware for parsing body and JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'admin')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB URI from environment variables
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error('MongoDB URI not defined!');
    process.exit(1);
}

// MongoDB connection
mongoose.connect(mongoURI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Could not connect to MongoDB', err));


// Multer setup for image uploads
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, './uploads');
    },
    filename: function(req, file, cb) {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const fileTypes = /jpeg|jpg|webp|png/;
        const extname = fileTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = fileTypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images are allowed!'));
        }
    }
});

// Unique registration check function
const isRegistrationUnique = async (registration) => {
    const car = await CarModel.findOne({ registration });
    return !car;
};

// POST route for adding a new car (admin)
// admin side form
app.post('/admin/cars', upload.array('images', 15), async (req, res) => {
    try {
        const { brand, model, year, price, registration, drivetrain, fuelType, transmission, mileage, description, source } = req.body;

        if (!brand || !model || !year || !price) {
            return res.status(400).json({ error: 'Brand, model, year, and price are required.' });
        }

        // Check if the car is imported
        const isImported = source === 'import';

        // Registration is optional for imported cars
        if (!isImported) {
            const isUnique = await isRegistrationUnique(registration);
            if (!isUnique) {
                return res.status(400).json({ error: 'Registration number must be unique.' });
            }
        }

        // Process uploaded images
        const images = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];

        // Save the car
        const newCar = new CarModel({
            brand,
            model,
            year,
            price,
            registration: isImported ? null : registration, // Null for imported cars
            drivetrain,
            fuelType,
            transmission,
            mileage,
            description,
            images,
            isInTransit: isImported // Mark as imported if source is "import"
        });

        const car = await newCar.save();

        // Emit the event for real-time updates
        carEventEmitter.emit('carAdded', car);

        res.status(201).json(car);
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Failed to add car', details: err.message });
    }
});


// POST route to add a car from the public side 
// public side form
app.post('/public/cars/add', upload.array('images', 15), async (req, res) => {
    try {
        const { brand, model, year, price, registration, drivetrain, fuelType, transmission, mileage, description } = req.body;

        // Validate required fields
        if (!brand || !model || !year || !price) {
            return res.status(400).json({ error: 'Brand, model, year, and price are required.' });
        }

        // Process uploaded images
        const images = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];

        // Create a new car instance
        const newCar = new CarModel({
            brand,
            model,
            year,
            price,
            registration,
            drivetrain,
            fuelType,
            transmission,
            mileage,
            description,
            images,
            source: 'public' // Mark this as uploaded from the public side
        });

        // Save the car to the database
        const car = await newCar.save();
        console.log('Car added successfully from public side:', car);

        // Emit event if needed
        carEventEmitter.emit('carAdded', car);

        // Send a success response
        res.status(201).json(car);
    } catch (err) {
        console.error('Error adding car from public side:', err);
        res.status(500).json({ error: 'Failed to add car', details: err.message });
    }
});


// GET route to fetch all cars with sorting and filtering
app.get('/admin/cars', async (req, res) => {
    try {
        const { brand, model, year, price, sortBy, limit = 100, skip = 0 } = req.query;
        const query = {};
        if (brand) query.brand = brand;
        if (model) query.model = new RegExp(model, 'i');
        if (year) query.year = year;
        if (price) {
            const priceRange = price.split('-');
            query.price = { $gte: Number(priceRange[0]), $lte: Number(priceRange[1]) };
        }
        const sortOptions = sortBy ? { [sortBy]: 1 } : {};
        const cars = await CarModel.find(query).sort(sortOptions).skip(parseInt(skip)).limit(parseInt(limit));
        res.json(cars);
    } catch (err) {
        res.status(500).send(err);
    }
});

// Route for fetching imported cars
app.get('/admin/cars/imported', async (req, res) => {
    try {
        const importedCars = await CarModel.find({ isInTransit: true });
        res.status(200).json(importedCars);
    } catch (error) {
        console.error('Error in /admin/cars/imported:', error.message);
        res.status(500).json({ error: 'Failed to fetch imported cars' });
    }
});

// Route for fetching a car by ID
app.get('/admin/cars/:id', async (req, res) => {
    try {
        const carId = req.params.id;

        // Validate if carId is a valid MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(carId)) {
            return res.status(400).json({ error: 'Invalid car ID format' });
        }

        const car = await CarModel.findById(carId);
        if (!car) {
            return res.status(404).json({ error: 'Car not found' });
        }
        res.status(200).json(car);
    } catch (error) {
        console.error('Error in /admin/cars/:id:', error.message);
        res.status(500).json({ error: 'Failed to fetch car by ID' });
    }
});




// SSE endpoint for real-time updates
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const carAddedListener = (car) => {
        res.write('event: carAdded\n');
        res.write(`data: ${JSON.stringify(car)}\n\n`);
    };
    const carUpdatedListener = (car) => {
        res.write('event: carUpdated\n');
        res.write(`data: ${JSON.stringify(car)}\n\n`);
    };
    const carDeletedListener = (carId) => {
        res.write('event: carDeleted\n');
        res.write(`data: ${JSON.stringify({ _id: carId })}\n\n`);
    };

    carEventEmitter.on('carAdded', carAddedListener);
    carEventEmitter.on('carUpdated', carUpdatedListener);
    carEventEmitter.on('carDeleted', carDeletedListener);

    req.on('close', () => {
        carEventEmitter.off('carAdded', carAddedListener);
        carEventEmitter.off('carUpdated', carUpdatedListener);
        carEventEmitter.off('carDeleted', carDeletedListener);
        res.end();
    });
});
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const listener = (car) => {
        if (car.isInTransit) {
            res.write(`data: ${JSON.stringify(car)}\n\n`);
        }
    };

    carEventEmitter.on('carAdded', listener);

    req.on('close', () => {
        carEventEmitter.off('carAdded', listener);
    });
});


// PUT route to update a car by ID
app.put('/admin/cars/:id', upload.array('images', 15), async (req, res) => {
    const carId = req.params.id;
    const removedImages = req.body.removedImages ? JSON.parse(req.body.removedImages) : [];
    
    if (!mongoose.Types.ObjectId.isValid(carId)) {
        return res.status(400).json({ error: 'Invalid car ID format' });
    }

    try {
        const currentCar = await CarModel.findById(carId);
        if (!currentCar) {
            return res.status(404).json({ error: 'Car not found' });
        }

        const updatedData = {
            brand: req.body.brand,
            model: req.body.model,
            year: req.body.year,
            price: req.body.price,
            registration: req.body.registration,
            drivetrain: req.body.drivetrain,
            fuelType: req.body.fuelType,
            transmission: req.body.transmission,
            mileage: req.body.mileage,
            description: req.body.description,
            images: [...currentCar.images],
        };

        if (req.files && req.files.length > 0) {
            updatedData.images = updatedData.images.concat(req.files.map(file => `/uploads/${file.filename}`));
        }

        if (removedImages.length > 0) {
            updatedData.images = updatedData.images.filter(img => !removedImages.includes(img));
        }

        const updatedCar = await CarModel.findByIdAndUpdate(carId, updatedData, { new: true });
        carEventEmitter.emit('carUpdated', updatedCar);

        // Send back the updated car
        res.json(updatedCar);
    } catch (err) {
        res.status(400).json({ error: 'Failed to update car', details: err.message });
    }
});


// DELETE route to remove a car
app.delete('/admin/cars/:id', async (req, res) => {
    const carId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(carId)) {
        return res.status(400).json({ error: 'Invalid car ID format' });
    }
    try {
        const deletedCar = await CarModel.findByIdAndDelete(carId);
        if (!deletedCar) {
            return res.status(404).json({ error: 'Car not found' });
        }
        carEventEmitter.emit('carDeleted', carId);
        res.json({ message: 'Car deleted successfully', deletedCar });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete car', details: err.message });
    }
});

// Import car route - allowing submission without registration (single route version)
app.post('/admin/cars/import-cars', upload.array('images'), async (req, res) => {
    const { brand, model, year, price, registration, drivetrain, fuelType, transmission, mileage, description, source } = req.body;
    const images = req.files.map(file => file.path); // Store image paths

    const car = new car({
        brand,
        model,
        year,
        price,
        registration, // No registration required for imports
        drivetrain,
        fuelType,
        transmission,
        mileage,
        description,
        images,
        isInTransit: true, // Mark as imported
        isUpdated: false
    });

    try {
        await car.save();
        res.status(201).json(car);
    } catch (error) {
        console.error('Error saving car:', error);
        res.status(500).json({ message: 'Error saving car. Please try again.' });
    }
});


// GET route to fetch all cars (public side)
app.get('/public/cars', async (req, res) => {
    try {
        const cars = await CarModel.find(); // Fetch all cars in the database
        res.json(cars);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch car list', details: err.message });
    }
});

// GET route to fetch imported cars only (public side)
app.get('/admin/cars/imported', async (req, res) => {
    try {
        console.log('Request received for imported cars');
        const importedCars = await CarModel.find({ isInTransit: true });
        console.log('Fetched cars:', importedCars);
        res.status(200).json(importedCars);
    } catch (error) {
        console.error('Error in /admin/cars/imported:', error.message);
        res.status(500).json({ error: 'Failed to fetch imported cars' });
    }
});


// SSE for all cars (public side)
app.get('/public/cars/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const carAddedListener = (car) => {
        res.write('event: carAdded\n');
        res.write(`data: ${JSON.stringify(car)}\n\n`);
    };

    const carUpdatedListener = (car) => {
        res.write('event: carUpdated\n');
        res.write(`data: ${JSON.stringify(car)}\n\n`);
    };

    const carDeletedListener = (carId) => {
        res.write('event: carDeleted\n');
        res.write(`data: ${JSON.stringify({ _id: carId })}\n\n`);
    };

    carEventEmitter.on('carAdded', carAddedListener);
    carEventEmitter.on('carUpdated', carUpdatedListener);
    carEventEmitter.on('carDeleted', carDeletedListener);

    req.on('close', () => {
        carEventEmitter.off('carAdded', carAddedListener);
        carEventEmitter.off('carUpdated', carUpdatedListener);
        carEventEmitter.off('carDeleted', carDeletedListener);
        res.end();
    });
});


// SSE for imported cars (public side)
app.get('/public/import-cars/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const carAddedListener = (car) => {
        if (car.source === 'import') {
            res.write('event: carAdded\n');
            res.write(`data: ${JSON.stringify(car)}\n\n`);
        }
    };

    const carUpdatedListener = (car) => {
        if (car.source === 'import') {
            res.write('event: carUpdated\n');
            res.write(`data: ${JSON.stringify(car)}\n\n`);
        }
    };

    const carDeletedListener = (carId) => {
        res.write('event: carDeleted\n');
        res.write(`data: ${JSON.stringify({ _id: carId })}\n\n`);
    };

    // Listen for imported car changes
    carEventEmitter.on('carAdded', carAddedListener);
    carEventEmitter.on('carUpdated', carUpdatedListener);
    carEventEmitter.on('carDeleted', carDeletedListener);

    req.on('close', () => {
        carEventEmitter.off('carAdded', carAddedListener);
        carEventEmitter.off('carUpdated', carUpdatedListener);
        carEventEmitter.off('carDeleted', carDeletedListener);
        res.end();
    });
});

// blog section
// Handle creating a new blog post with thumbnail upload
app.post('/admin/blogs', upload.single('thumbnail'), async (req, res) => {
    const { postTitle, postContent, postStatus } = req.body;
    const thumbnail = req.file ? `/uploads/${req.file.filename}` : null; // Get filename if uploaded
    try {
        const newBlogPost = new BlogPost({ 
            title: postTitle, 
            content: postContent, 
            status: postStatus, 
            thumbnail 
        });
        await newBlogPost.save(); // Save the new blog post
        res.status(201).json(newBlogPost); // Send the created blog post as response
    } catch (error) {
        console.error('Error saving blog:', error);
        res.status(500).json('Failed to create blog post');
    }
});



// Get all published blogs for the admin side
app.get('/admin/blogs', async (req, res) => {
    try {
        const blogs = await BlogPost.find().sort({ date: -1 });
        res.json(blogs);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch blogs' });
    }
});

// Get only published blog posts for the public side
app.get('/blogs', async (req, res) => {
    try {
        const blogs = await BlogPost.find({ status: 'Published' }).sort({ date: -1 });
        res.json(blogs);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch published blogs' });
    }
});

// Update a blog post
app.put('/admin/blogs/:id', upload.single('thumbnail'), async (req, res) => {
    const { title, content, status, author } = req.body;
    const thumbnail = req.file ? `/uploads/${req.file.filename}` : undefined;

    try {
        const blog = await BlogPost.findById(req.params.id);
        if (!blog) return res.status(404).send('Blog not found');

        blog.title = title;
        blog.content = content;
        blog.status = status;
        blog.author = author;
        if (thumbnail) blog.thumbnail = thumbnail;

        await blog.save();
        res.json(blog);
    } catch (error) {
        console.error('Error updating blog:', error);
        res.status(500).send('Error updating blog');
    }
});

// Delete a blog (admin only)
app.delete('/admin/blogs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await BlogPost.findByIdAndDelete(id);
        res.status(200).json({ message: 'Blog deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete blog' });
    }
});

// admin dashbboard
// Route to get total car count
app.get('/admin/total-cars', async (req, res) => {
    try {
        const carCount = await CarModel.countDocuments(); // Assuming CarModel is your Mongoose model
        res.json({ count: carCount });
    } catch (error) {
        console.error('Error fetching car count:', error);
        res.status(500).json({ error: 'Failed to fetch car count' });
    }
});

// Route to get total blog post count
app.get('/admin/total-blogs', async (req, res) => {
    try {
        const blogCount = await BlogModel.countDocuments(); // Assuming BlogModel is your Mongoose model
        res.json({ count: blogCount });
    } catch (error) {
        console.error('Error fetching blog count: error');
        res.status(500).json({ error: 'Failed to fetch blog count' });
    }
});


// admin-user management
// admin user
app.post("/admin/login", async (req, res) => {
    const { username, password } = req.body;
  
    console.log("Received login attempt:", { username, password });
  
    // Find the user by username
    const user = await User.findOne({ username });
  
    if (!user) {
      console.log("User not found");
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }
  
    // Verify the password
    const isPasswordMatch = bcrypt.compareSync(password, user.password);
    console.log("Password match result:", isPasswordMatch);
  
    if (isPasswordMatch) {
      // Generate JWT token with roles and permissions
      const token = jwt.sign(
        {
          userId: user._id,
          roles: user.roles, // Include roles such as 'super_admin', 'admin', etc.
          permissions: user.permissions || [] // Include user-specific permissions
        },
        "your_secret_key", // Replace with your secret key from .env or config
        { expiresIn: "30m" } // Token expires in 30 minutes
      );
  
      // Set the token as a cookie
      res.cookie("admin-token", token, { httpOnly: true, secure: false, maxAge: 30 * 60 * 1000});
      console.log("Login successful, redirecting to admin page");
      // Redirect to the admin dashboard
      return res.redirect("/admin.html");
    } else {
      console.log("Invalid password");
      return res.status(401).send("Login failed");
    }
  });
  

  // Middleware to authenticate and check the role
  const authenticateAdmin = (req, res, next) => {
    const token = req.cookies["admin-token"];
    if (!token) {
      console.log("No token found, redirecting to login page");
      return res.redirect("/admin-login.html");
    }
  
    try {
      const decoded = jwt.verify(token, "your_secret_key");
      req.user = decoded;

       // Permission check for user-management page
    const requiredPermission = req.originalUrl.includes("user-management")
    ? "manage-users"
    : null;

  if (requiredPermission && !decoded.permissions.includes(requiredPermission)) {
    console.log("Access denied. Missing permission:", requiredPermission);
    return res.redirect("/admin-login.html");
  }

      next(); // Proceed if token is valid
    } catch (error) {
      console.log("Invalid token, redirecting to login page");
      return res.redirect("/admin-login.html");
    }
  };
  
  // Serve admin login page without protection
app.get("/admin-login.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin-login.html")); // Adjust path if needed
  });
  
  // Apply middleware to protect other admin routes
  app.use("/admin", authenticateAdmin);
  
  
  // Apply this middleware to protect admin routes
  app.use("/admin", authenticateAdmin);
  
// user management
app.get("/admin/users", async (req, res) => {
    try {
      const users = await User.find({}, { username: 1, email: 1, roles: 1 });
      res.json(users); // Send only required fields
    } catch (err) {
      console.error(err);
      res.status(500).send("Error fetching users");
    }
  });
  app.post("/admin/update-roles", async (req, res) => {
    const { userId, roles } = req.body;
  
    if (!userId || !roles) {
      return res.status(400).send("Missing user ID or roles");
    }
  
    try {
      await User.findByIdAndUpdate(userId, { roles });
      res.send("Roles updated successfully");
    } catch (err) {
      console.error(err);
      res.status(500).send("Error updating roles");
    }
  });

  app.post("/admin/users/create", async (req, res) => {
    const { username, password, roles } = req.body;
  
    // Default permissions based on roles
    let permissions = [];
    if (roles.includes("super_admin")) {
      permissions = ["manage-cars", "manage-users"];
    } else if (roles.includes("admin")) {
      permissions = ["manage-cars"];
    }
  
    const hashedPassword = bcrypt.hashSync(password, 10);
  
    const newUser = new User({
      username,
      password: hashedPassword,
      roles,
      permissions,
    });
  
    try {
      await newUser.save();
      res.status(201).json({ success: true, message: "User created successfully" });
    } catch (error) {
      console.error("Error creating user:", error);
      res.status(500).json({ success: false, message: "Failed to create user" });
    }
  });
  

//   add user
app.post("/admin/add-user", async (req, res) => {
    try {
      const { username, email, password, permissions } = req.body;
  
      const hashedPassword = await bcrypt.hash(password, 10);
  
      const newUser = new User({
        username,
        email,
        password: hashedPassword,
        roles: ["admin"], // Default role is "admin"
        permissions, // Permissions assigned from the form
      });
  
      await newUser.save();
      res.json({ success: true, message: "User added successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Failed to add user" });
    }
  });
  
  const checkPermissions = (requiredPermission) => {
    return (req, res, next) => {
      const token = req.cookies["admin-token"];
      if (!token) {
        return res.redirect("/admin-login.html");
      }
  
      try {
        const decoded = jwt.verify(token, "your_secret_key");
        req.user = decoded;

         // Allow super_admin access to all pages
      if (decoded.roles && decoded.roles.includes("super_admin")) {
        return next();
      }
           // Allow admin access to all pages
           if (decoded.roles && decoded.roles.includes("admin")) {
            return next();
          }
  
        if (!decoded.permissions || !decoded.permissions.includes(requiredPermission)) {
          return res.status(403).send("Access Denied: You do not have permission to access this page.");
        }
  
        next();
      } catch (err) {
        console.error(err);
        return res.redirect("/admin-login.html");
      }
    };
  };
  
  app.get("/admin/manage-cars.html", checkPermissions("manage-cars"), (req, res) => {
    res.sendFile(__dirname + "/admin/manage-cars.html");
  });
  
  app.get("/admin/blog-management.html", checkPermissions("blog-management"), (req, res) => {
    res.sendFile(__dirname + "/admin/blog-management.html");
  });
  app.get("/admin/manage-cars", authenticateAdmin, (req, res) => {
    res.render("manage-cars"); // Or render the page, or serve the data
  });
  app.get("/admin/user-management", authenticateAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, "views", "user-management.html"));
  });
  // Only super_admins can access the user-management page
app.get("/admin/user-management.html", checkAccess("super_admin"), (req, res) => {
    res.sendFile(path.join(__dirname, "admin" , "user-management.html"));
  });

 

  
  
  

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
1