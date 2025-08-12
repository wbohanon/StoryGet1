
const express = require('express');
const path = require('path');
const fs = require('fs');
const EnhancedStoryScraper = require('./enhanced-scraper-v3');

const app = express();
app.use(express.json());

// Serve static files with explicit content types
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

let scraper;

(async () => {
    try {
        scraper = new EnhancedStoryScraper();
        await scraper.init();
        console.log('✅ Enhanced Story Scraper initialized and ready');
    } catch (error) {
        console.error('❌ Failed to initialize scraper:', error);
        process.exit(1);
    }
})();

// Single URL scraping
app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Missing url in request body.' });
    }
    try {
        console.log(`Scraping URL: ${url}`);
        const result = await scraper.scrape(url);
        console.log(`Successfully scraped: ${result.title}`);
        res.json(result);
    } catch (err) {
        console.error(`Error scraping ${url}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Debug scraping with detailed extraction info
app.post('/debug-scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Missing url in request body.' });
    }
    try {
        console.log(`Debug scraping URL: ${url}`);
        const result = await scraper.debugScrape(url);
        res.json(result);
    } catch (err) {
        console.error(`Error debug scraping ${url}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Batch scraping - find links on a page
app.post('/scrape-links', async (req, res) => {
    const { url, options } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Missing url in request body.' });
    }
    try {
        console.log(`Finding story links on: ${url}`);
        const result = await scraper.scrapeLinksFromPage(url, options);
        res.json(result);
    } catch (err) {
        console.error(`Error finding links on ${url}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Get all stories from the database
app.get('/stories', async (req, res) => {
    try {
        const stories = await scraper.getAllStories();
        res.json(stories);
    } catch (err) {
        console.error('Error fetching stories:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get a single story by ID
app.get('/story/:id', async (req, res) => {
    try {
        const story = await scraper.getStoryById(req.params.id);
        if (!story) {
            return res.status(404).json({ error: 'Story not found' });
        }
        res.json(story);
    } catch (err) {
        console.error(`Error fetching story ${req.params.id}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Delete a story
app.delete('/story/:id', async (req, res) => {
    try {
        const result = await scraper.deleteStory(req.params.id);
        if (result === 0) {
            return res.status(404).json({ error: 'Story not found' });
        }
        res.json({ success: true, message: 'Story deleted successfully' });
    } catch (err) {
        console.error(`Error deleting story ${req.params.id}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Export stories
app.get('/export', async (req, res) => {
    try {
        const format = req.query.format || 'json';
        const filename = req.query.filename || `stories.${format}`;
        
        console.log(`Exporting stories as ${format} to ${filename}`);
        const result = await scraper.exportStories(format, filename);
        
        res.json(result);
    } catch (err) {
        console.error('Error exporting stories:', err);
        res.status(500).json({ error: err.message });
    }
});

// Download exported file
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, filename);
    
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// ===== NEW FEATURE ENDPOINTS =====

// Collections endpoints
app.get('/collections', async (req, res) => {
    try {
        const collections = await scraper.getAllCollections();
        res.json(collections);
    } catch (err) {
        console.error('Error fetching collections:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/collections', async (req, res) => {
    const { name, description, color } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Collection name is required' });
    }
    try {
        const collection = await scraper.createCollection(name, description, color);
        res.json(collection);
    } catch (err) {
        console.error('Error creating collection:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/collections/:id/stories', async (req, res) => {
    try {
        const stories = await scraper.getStoriesInCollection(req.params.id);
        res.json(stories);
    } catch (err) {
        console.error('Error fetching collection stories:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/collections/:collectionId/stories/:storyId', async (req, res) => {
    try {
        const added = await scraper.addStoryToCollection(req.params.storyId, req.params.collectionId);
        res.json({ success: added });
    } catch (err) {
        console.error('Error adding story to collection:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/collections/:collectionId/stories/:storyId', async (req, res) => {
    try {
        const removed = await scraper.removeStoryFromCollection(req.params.storyId, req.params.collectionId);
        res.json({ success: removed });
    } catch (err) {
        console.error('Error removing story from collection:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/collections/:id', async (req, res) => {
    try {
        const result = await scraper.deleteCollection(req.params.id);
        if (result === 0) {
            return res.status(404).json({ error: 'Collection not found' });
        }
        res.json({ success: true, message: 'Collection deleted successfully' });
    } catch (err) {
        console.error('Error deleting collection:', err);
        res.status(500).json({ error: err.message });
    }
});

// Story recommendations
app.get('/story/:id/similar', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;
        const similarStories = await scraper.getSimilarStories(req.params.id, limit);
        res.json(similarStories);
    } catch (err) {
        console.error('Error getting similar stories:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/story/:id/read', async (req, res) => {
    try {
        await scraper.markStoryAsRead(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Error marking story as read:', err);
        res.status(500).json({ error: err.message });
    }
});

// RSS Feed endpoints
app.get('/rss-feeds', async (req, res) => {
    try {
        const feeds = await scraper.getAllRSSFeeds();
        res.json(feeds);
    } catch (err) {
        console.error('Error fetching RSS feeds:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/rss-feeds', async (req, res) => {
    const { url, title, description } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'RSS feed URL is required' });
    }
    try {
        const feed = await scraper.addRSSFeed(url, title, description);
        res.json(feed);
    } catch (err) {
        console.error('Error adding RSS feed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/rss-feeds/:id/check', async (req, res) => {
    try {
        const result = await scraper.checkRSSFeed(req.params.id);
        res.json(result);
    } catch (err) {
        console.error('Error checking RSS feed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/rss-items/unscraped', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const items = await scraper.getUnscrapedRSSItems(limit);
        res.json(items);
    } catch (err) {
        console.error('Error fetching unscraped RSS items:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/rss-items/scrape', async (req, res) => {
    try {
        const limit = parseInt(req.body.limit) || 5;
        const results = await scraper.scrapeRSSItems(limit);
        res.json(results);
    } catch (err) {
        console.error('Error scraping RSS items:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/rss-feeds/:id', async (req, res) => {
    try {
        const result = await scraper.deleteRSSFeed(req.params.id);
        if (result === 0) {
            return res.status(404).json({ error: 'RSS feed not found' });
        }
        res.json({ success: true, message: 'RSS feed deleted successfully' });
    } catch (err) {
        console.error('Error deleting RSS feed:', err);
        res.status(500).json({ error: err.message });
    }
});

// Enhanced search
app.post('/search', async (req, res) => {
    try {
        const { query, options } = req.body;
        const results = await scraper.searchStories(query, options);
        res.json(results);
    } catch (err) {
        console.error('Error searching stories:', err);
        res.status(500).json({ error: err.message });
    }
});

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Test routes for static files
app.get('/test-css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.sendFile(path.join(__dirname, 'public', 'styles.css'));
});

app.get('/test-js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.get('/test', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

// Handle 404s
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Enhanced Story Scraper web app running on http://localhost:${PORT}`);
});
