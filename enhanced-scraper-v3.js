const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

class EnhancedStoryScraper {
    constructor() {
        this.db = null;
        this.browser = null;
    }

    async init() {
        // Initialize database
        this.db = new sqlite3.Database('stories.db');
        
        // Check and migrate database schema
        await this.migrateDatabase();
        
        // Initialize browser
        this.browser = await puppeteer.launch({ headless: true });
        console.log('Enhanced scraper initialized');
    }

    async migrateDatabase() {
        // Check current schema
        const columns = await new Promise((resolve, reject) => {
            this.db.all("PRAGMA table_info(stories)", (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(row => row.name));
            });
        });
        

        // If table doesn't exist, create it with full schema
        if (columns.length === 0) {
            await new Promise((resolve, reject) => {
                this.db.run(`
                    CREATE TABLE stories (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        url TEXT UNIQUE,
                        title TEXT,
                        content TEXT,
                        author TEXT,
                        word_count INTEGER,
                        domain TEXT,
                        scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        tags TEXT,
                        read_count INTEGER DEFAULT 0,
                        last_read DATETIME,
                        similarity_keywords TEXT
                    )
                `, (err) => {
                    if (err) reject(err);
                    else {
                        console.log('Created new stories table with enhanced schema');
                        resolve();
                    }
                });
            });
            
            // Create additional tables for new features
            await this.createAdditionalTables();
            await this.createIndexes();
            return;
        }

        // Migrate existing table by adding missing columns
        const requiredColumns = [
            { name: 'author', type: 'TEXT' },
            { name: 'word_count', type: 'INTEGER' },
            { name: 'domain', type: 'TEXT' },
            { name: 'tags', type: 'TEXT' },
            { name: 'read_count', type: 'INTEGER DEFAULT 0' },
            { name: 'last_read', type: 'DATETIME' },
            { name: 'similarity_keywords', type: 'TEXT' }
        ];

        for (const column of requiredColumns) {
            if (!columns.includes(column.name)) {
                await new Promise((resolve, reject) => {
                    this.db.run(`ALTER TABLE stories ADD COLUMN ${column.name} ${column.type}`, (err) => {
                        if (err) reject(err);
                        else {
                            console.log(`Added column: ${column.name}`);
                            resolve();
                        }
                    });
                });
            }
        }

        // Create additional tables and indexes for new features
        await this.createAdditionalTables();
        await this.createIndexes();

        // Update existing records with missing data
        await this.updateExistingRecords();
    }

    async updateExistingRecords() {
        // Get records that need updating
        const recordsToUpdate = await new Promise((resolve, reject) => {
            this.db.all(`
                SELECT id, url, content 
                FROM stories 
                WHERE word_count IS NULL OR domain IS NULL
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (recordsToUpdate.length > 0) {
            console.log(`Updating ${recordsToUpdate.length} existing records...`);
            
            for (const record of recordsToUpdate) {
                try {
                    const wordCount = record.content ? record.content.split(/\s+/).length : 0;
                    const domain = record.url ? new URL(record.url).hostname : '';
                    
                    await new Promise((resolve, reject) => {
                        this.db.run(
                            'UPDATE stories SET word_count = ?, domain = ? WHERE id = ?',
                            [wordCount, domain, record.id],
                            (err) => {
                                if (err) reject(err);
                                else resolve();
                            }
                        );
                    });
                } catch (error) {
                    console.error(`Error updating record ${record.id}:`, error);
                }
            }

            console.log('Database migration completed');
        }
    }

    async scrape(url) {
        console.log('🔍 Scraping:', url);
        
        // Check if story already exists
        const existingStory = await new Promise((resolve, reject) => {
            this.db.get('SELECT id, title FROM stories WHERE url = ?', [url], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingStory) {
            console.log('⚠️  Story already exists:', existingStory.title);
            return { 
                skipped: true, 
                reason: 'Story already exists',
                story: existingStory 
            };
        }
        
        const page = await this.browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });
        
        const html = await page.content();
        const $ = cheerio.load(html);
        
        // Enhanced content extraction
        const title = this.extractTitle($);
        const content = this.extractContent($);
        const author = this.extractAuthor($);
        const domain = new URL(url).hostname;
        const wordCount = content.split(/\s+/).length;
        
        // Generate similarity keywords
        const similarityKeywords = await this.generateSimilarityKeywords(content, title, author);
        
        await page.close();
        
        // Save to database with enhanced data
        const storyId = await new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO stories (url, title, content, author, word_count, domain, similarity_keywords) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [url, title, content, author, wordCount, domain, similarityKeywords],
                function(err) {
                    if (err) {
                        console.error('❌ Database error:', err.message);
                        reject(err);
                    } else {
                        console.log('✅ Saved story:', title);
                        resolve(this.lastID);
                    }
                }
            );
        });
        
        const story = { id: storyId, title, content, author, wordCount, domain, url };
        return { story, skipped: false };
    }

    async scrapeLinksFromPage(pageUrl, options = {}) {
        console.log('🔍 Finding story links on:', pageUrl);
        
        const {
            linkSelector = 'a[href]',
            filterPatterns = [],
            excludePatterns = ['/css/', '/js/', '/images/', '.jpg', '.png', '.gif', '.pdf', '.zip', '.exe', 'mailto:', 'tel:'],
            sameDomain = true,
            maxLinks = 10,
            keywords = []
        } = options;

        const page = await this.browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'networkidle2' });
        
        const html = await page.content();
        const $ = cheerio.load(html);
        const baseDomain = new URL(pageUrl).hostname;
        
        const links = [];
        
        $(linkSelector).each((i, element) => {
            const href = $(element).attr('href');
            const text = $(element).text().trim();
            
            if (!href) return;
            
            let fullUrl;
            try {
                fullUrl = new URL(href, pageUrl).href;
            } catch (e) {
                return; // Skip invalid URLs
            }
            
            const linkDomain = new URL(fullUrl).hostname;
            
            // Apply same domain filter
            if (sameDomain && linkDomain !== baseDomain) return;
            
            // Apply exclude patterns
            if (excludePatterns.some(pattern => fullUrl.includes(pattern))) return;
            
            // Apply keyword filters
            if (keywords.length > 0) {
                const linkText = text.toLowerCase();
                const hasKeyword = keywords.some(keyword => 
                    linkText.includes(keyword.toLowerCase()) || 
                    fullUrl.toLowerCase().includes(keyword.toLowerCase())
                );
                if (!hasKeyword) return;
            }
            
            links.push({
                url: fullUrl,
                text: text,
                domain: linkDomain
            });
        });
        
        await page.close();
        
        // Remove duplicates and limit results
        const uniqueLinks = Array.from(new Map(links.map(link => [link.url, link])).values());
        const linksToScrape = uniqueLinks.slice(0, maxLinks);
        
        console.log(`📋 Found ${links.length} total links, ${uniqueLinks.length} unique, returning ${linksToScrape.length}`);
        
        // Show preview of links to be scraped
        console.log('\n📋 Links to scrape:');
        linksToScrape.slice(0, 10).forEach((link, i) => {
            console.log(`  ${i + 1}. ${link.text || 'Untitled'}`);
            console.log(`     ${link.url}`);
        });
        
        return {
            totalFound: links.length,
            uniqueLinks: uniqueLinks.length,
            linksToScrape: linksToScrape,
            preview: linksToScrape.slice(0, 10)
        };
    }

    async batchScrapeFromLinks(links, options = {}) {
        const { 
            delay = 2000,
            skipExisting = true,
            minWordCount = 100 
        } = options;
        
        const results = {
            successful: 0,
            skipped: 0,
            failed: 0,
            stories: []
        };
        
        console.log(`\n🚀 Starting batch scrape of ${links.length} links...`);
        
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            console.log(`\n[${i + 1}/${links.length}] Processing: ${link.text || 'Untitled'}`);
            console.log(`URL: ${link.url}`);
            
            try {
                // Check if already exists
                if (skipExisting) {
                    const existing = await this.getStoryByUrl(link.url);
                    if (existing) {
                        console.log('⏭️  Skipping - already exists');
                        results.skipped++;
                        continue;
                    }
                }
                
                const result = await this.scrape(link.url);
                
                // Check if content is substantial enough
                if (result.wordCount < minWordCount) {
                    console.log(`⏭️  Skipping - too short (${result.wordCount} words)`);
                    results.skipped++;
                    continue;
                }
                
                console.log(`✅ Success: "${result.title}" (${result.wordCount} words)`);
                results.successful++;
                results.stories.push(result);
                
            } catch (error) {
                console.log(`❌ Failed: ${error.message}`);
                results.failed++;
            }
            
            // Add delay between requests
            if (i < links.length - 1 && delay > 0) {
                console.log(`⏳ Waiting ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        console.log('\n📊 Batch scraping completed:');
        console.log(`✅ Successful: ${results.successful}`);
        console.log(`⏭️  Skipped: ${results.skipped}`);
        console.log(`❌ Failed: ${results.failed}`);
        
        return results;
    }

    async getStoryByUrl(url) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM stories WHERE url = ?', [url], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    extractTitle($) {
        // Try multiple selectors for title
        const selectors = [
            'h1',
            '.title',
            '.story-title',
            '.post-title',
            '.entry-title',
            'title',
            '.headline',
            '.article-title'
        ];
        
        for (const selector of selectors) {
            const element = $(selector).first();
            if (element.length && element.text().trim()) {
                return this.cleanTitle(element.text().trim());
            }
        }
        
        // Fallback to page title
        const pageTitle = $('title').text().trim();
        return pageTitle ? this.cleanTitle(pageTitle) : 'Untitled';
    }

    extractContent($) {
        // Remove unwanted elements
        $('script, style, nav, header, footer, .sidebar, .menu, .navigation, .ads, .advertisement').remove();
        
        // Try multiple content selectors with scoring
        const contentSelectors = [
            '.story-content',
            '.post-content',
            '.entry-content',
            '.article-content',
            '.content',
            'article',
            '.main-content',
            '#content',
            '.text',
            'main'
        ];
        
        let bestContent = '';
        let bestScore = 0;
        
        for (const selector of contentSelectors) {
            const element = $(selector).first();
            if (element.length) {
                const text = element.text().trim();
                const score = this.scoreContent(text);
                
                if (score > bestScore) {
                    bestScore = score;
                    bestContent = text;
                }
            }
        }
        
        // If no good content found, try paragraphs
        if (!bestContent || bestScore < 100) {
            const paragraphs = $('p').map((i, el) => $(el).text().trim()).get();
            const combinedText = paragraphs.join('\n\n');
            
            if (this.scoreContent(combinedText) > bestScore) {
                bestContent = combinedText;
            }
        }
        
        return bestContent || 'No content found';
    }

    scoreContent(text) {
        if (!text) return 0;
        
        const wordCount = text.split(/\s+/).length;
        const sentenceCount = text.split(/[.!?]+/).length;
        const avgWordsPerSentence = wordCount / Math.max(sentenceCount, 1);
        
        // Score based on length and structure
        let score = wordCount;
        
        // Bonus for reasonable sentence length
        if (avgWordsPerSentence > 5 && avgWordsPerSentence < 30) {
            score += 50;
        }
        
        // Penalty for very short content
        if (wordCount < 50) {
            score -= 100;
        }
        
        return score;
    }

    extractAuthor($) {
        const authorSelectors = [
            '.author',
            '.by-author',
            '.story-author',
            '.post-author',
            '.byline',
            '[rel="author"]',
            '.writer',
            '.created-by'
        ];
        
        for (const selector of authorSelectors) {
            const element = $(selector).first();
            if (element.length && element.text().trim()) {
                return element.text().trim().replace(/^by\s+/i, '');
            }
        }
        
        return null;
    }

    async getAllStories() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM stories ORDER BY scraped_at DESC', (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async getStoryById(id) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM stories WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async deleteStory(id) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM stories WHERE id = ?', [id], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    async exportStories(format = 'json', filename = null) {
        const stories = await this.getAllStories();
        
        if (!filename) {
            filename = `stories.${format}`;
        }

        switch (format.toLowerCase()) {
            case 'json':
                return this.exportJSON(stories, filename);
            case 'csv':
                return this.exportCSV(stories, filename);
            case 'txt':
                return this.exportTXT(stories, filename);
            case 'html':
                return this.exportHTML(stories, filename);
            case 'epub':
                return this.exportEPUB(stories, filename);
            case 'markdown':
            case 'md':
                return this.exportMarkdown(stories, filename);
            default:
                throw new Error('Unsupported format: ' + format);
        }
    }

    exportJSON(stories, filename) {
        const data = JSON.stringify(stories, null, 2);
        fs.writeFileSync(filename, data);
        return { filename, count: stories.length, format: 'JSON' };
    }

    exportCSV(stories, filename) {
        if (stories.length === 0) {
            fs.writeFileSync(filename, '');
            return { filename, count: 0, format: 'CSV' };
        }

        const headers = ['id', 'title', 'author', 'domain', 'word_count', 'scraped_at', 'url'];
        const csvContent = [
            headers.join(','),
            ...stories.map(story => 
                headers.map(header => {
                    const value = story[header] || '';
                    return `"${String(value).replace(/"/g, '""')}"`;
                }).join(',')
            )
        ].join('\n');

        fs.writeFileSync(filename, csvContent);
        return { filename, count: stories.length, format: 'CSV' };
    }

    exportTXT(stories, filename) {
        const content = stories.map(story => {
            return [
                '=' .repeat(60),
                `Title: ${story.title}`,
                `Author: ${story.author || 'Unknown'}`,
                `Domain: ${story.domain}`,
                `Word Count: ${story.word_count}`,
                `Scraped: ${story.scraped_at}`,
                `URL: ${story.url}`,
                '=' .repeat(60),
                '',
                story.content,
                '',
                ''
            ].join('\n');
        }).join('\n');

        fs.writeFileSync(filename, content);
        return { filename, count: stories.length, format: 'TXT' };
    }

    exportHTML(stories, filename) {
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scraped Stories Collection</title>
    <style>
        body { font-family: Georgia, serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .story { margin-bottom: 40px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
        .story-title { color: #333; font-size: 24px; margin-bottom: 10px; }
        .story-meta { color: #666; font-size: 14px; margin-bottom: 20px; }
        .story-content { line-height: 1.6; text-align: justify; }
        .toc { background: #f5f5f5; padding: 20px; margin-bottom: 30px; }
        .toc h2 { margin-top: 0; }
        .toc a { text-decoration: none; color: #333; }
        .toc a:hover { color: #007bff; }
    </style>
</head>
<body>
    <h1>Scraped Stories Collection</h1>
    <div class="toc">
        <h2>Table of Contents</h2>
        <ol>
            ${stories.map((story, index) => 
                `<li><a href="#story-${index + 1}">${story.title}</a> - ${story.author || 'Unknown'}</li>`
            ).join('')}
        </ol>
    </div>
    
    ${stories.map((story, index) => `
        <div class="story" id="story-${index + 1}">
            <h2 class="story-title">${story.title}</h2>
            <div class="story-meta">
                <strong>Author:</strong> ${story.author || 'Unknown'} | 
                <strong>Source:</strong> ${story.domain} | 
                <strong>Words:</strong> ${story.word_count} | 
                <strong>Scraped:</strong> ${story.scraped_at}
            </div>
            <div class="story-content">
                ${story.content.split('\n').map(p => p.trim() ? `<p>${p}</p>` : '').join('')}
            </div>
        </div>
    `).join('')}
</body>
</html>`;

        fs.writeFileSync(filename, html);
        return { filename, count: stories.length, format: 'HTML' };
    }

    exportMarkdown(stories, filename) {
        const content = stories.map((story, index) => {
            return [
                `# ${story.title}`,
                '',
                `**Author:** ${story.author || 'Unknown'}  `,
                `**Source:** ${story.domain}  `,
                `**Words:** ${story.word_count}  `,
                `**Scraped:** ${story.scraped_at}  `,
                `**URL:** ${story.url}`,
                '',
                '---',
                '',
                story.content.split('\n').map(p => p.trim()).filter(p => p).join('\n\n'),
                '',
                '---',
                ''
            ].join('\n');
        }).join('\n');

        fs.writeFileSync(filename, content);
        return { filename, count: stories.length, format: 'Markdown' };
    }

    exportEPUB(stories, filename) {
        // Basic EPUB structure - in production, use a proper EPUB library
        const content = stories.map(story => ({
            title: story.title,
            author: story.author || 'Unknown',
            content: story.content
        }));
        
        // For now, export as JSON with EPUB extension
        const data = JSON.stringify(content, null, 2);
        fs.writeFileSync(filename, data);
        return { filename, count: stories.length, format: 'EPUB (JSON)' };
    }

    async debugScrape(url) {
        console.log('\n🔍 DEBUG SCRAPING:', url);
        console.log('='.repeat(50));
        
        const page = await this.browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });
        
        const html = await page.content();
        const $ = cheerio.load(html);
        
        console.log('\n🎯 TITLE EXTRACTION:');
        const titleSelectors = ['h1', '.title', '.story-title', '.post-title', '.entry-title', 'title'];
        titleSelectors.forEach(selector => {
            const element = $(selector).first();
            if (element.length) {
                console.log(`  ${selector}: "${element.text().trim()}"`);
            }
        });
        
        console.log('\n👤 AUTHOR EXTRACTION:');
        const authorSelectors = ['.author', '.by-author', '.story-author', '.post-author', '.byline'];
        authorSelectors.forEach(selector => {
            const element = $(selector).first();
            if (element.length) {
                console.log(`  ${selector}: "${element.text().trim()}"`);
            }
        });
        
        console.log('\n📝 CONTENT EXTRACTION:');
        const contentSelectors = ['.story-content', '.post-content', '.entry-content', '.article-content', '.content', 'article'];
        contentSelectors.forEach(selector => {
            const element = $(selector).first();
            if (element.length) {
                const text = element.text().trim();
                const score = this.scoreContent(text);
                console.log(`  ${selector}: ${text.length} chars, score: ${score}`);
                console.log(`    Preview: "${text.substring(0, 100)}..."`);
            }
        });
        
        await page.close();
        
        console.log('\n🎯 ACTUAL EXTRACTION RESULTS:');
        console.log('='.repeat(50));
        const result = await this.scrape(url);
        console.log(`Title: "${result.title}"`);
        console.log(`Author: "${result.author || 'None'}"`);
        console.log(`Content: ${result.content.length} chars`);
        console.log(`Word count: ${result.wordCount}`);
        console.log(`Content preview: "${result.content.substring(0, 200)}..."`);
        
        return result;
    }

    cleanTitle(title) {
        if (!title) return '';
        
        // Remove common site suffixes
        title = title.replace(/\s*[-|–—]\s*.+$/, ''); // Remove everything after dash/pipe
        title = title.replace(/\s*\|\s*.+$/, ''); // Remove everything after pipe
        
        // Remove common prefixes/suffixes
        const patterns = [
            /^(story|chapter|part)\s*:?\s*/i,
            /\s*-\s*(read online|free|story)$/i,
            /\s*\(.*\)$/,  // Remove parenthetical content at end
        ];
        
        patterns.forEach(pattern => {
            title = title.replace(pattern, '');
        });
        
        return title.trim();
    }

    // ===== NEW FEATURES =====

    async createAdditionalTables() {
        // Collections table
        await new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    color TEXT DEFAULT '#4a6fa5'
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Story-Collection relationship table
        await new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS story_collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    story_id INTEGER,
                    collection_id INTEGER,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (story_id) REFERENCES stories (id) ON DELETE CASCADE,
                    FOREIGN KEY (collection_id) REFERENCES collections (id) ON DELETE CASCADE,
                    UNIQUE(story_id, collection_id)
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // RSS Feeds table
        await new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS rss_feeds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url TEXT UNIQUE NOT NULL,
                    title TEXT,
                    description TEXT,
                    last_checked DATETIME,
                    last_updated DATETIME,
                    active BOOLEAN DEFAULT 1,
                    check_interval INTEGER DEFAULT 3600,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // RSS Feed Items table
        await new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS rss_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feed_id INTEGER,
                    title TEXT,
                    url TEXT UNIQUE,
                    description TEXT,
                    pub_date DATETIME,
                    scraped BOOLEAN DEFAULT 0,
                    story_id INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (feed_id) REFERENCES rss_feeds (id) ON DELETE CASCADE,
                    FOREIGN KEY (story_id) REFERENCES stories (id) ON DELETE SET NULL
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        console.log('Additional tables created successfully');
    }

    async createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_stories_title ON stories(title)',
            'CREATE INDEX IF NOT EXISTS idx_stories_author ON stories(author)',
            'CREATE INDEX IF NOT EXISTS idx_stories_domain ON stories(domain)',
            'CREATE INDEX IF NOT EXISTS idx_stories_scraped_at ON stories(scraped_at)',
            'CREATE INDEX IF NOT EXISTS idx_stories_word_count ON stories(word_count)',
            'CREATE INDEX IF NOT EXISTS idx_stories_read_count ON stories(read_count)',
            'CREATE INDEX IF NOT EXISTS idx_story_collections_story ON story_collections(story_id)',
            'CREATE INDEX IF NOT EXISTS idx_story_collections_collection ON story_collections(collection_id)',
            'CREATE INDEX IF NOT EXISTS idx_rss_items_feed ON rss_items(feed_id)',
            'CREATE INDEX IF NOT EXISTS idx_rss_items_url ON rss_items(url)',
            'CREATE INDEX IF NOT EXISTS idx_rss_items_scraped ON rss_items(scraped)'
        ];

        for (const indexSql of indexes) {
            await new Promise((resolve, reject) => {
                this.db.run(indexSql, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        console.log('Database indexes created successfully');
    }

    // ===== COLLECTIONS FEATURE =====

    async createCollection(name, description = '', color = '#4a6fa5') {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO collections (name, description, color) VALUES (?, ?, ?)',
                [name, description, color],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID, name, description, color });
                }
            );
        });
    }

    async getAllCollections() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT c.*, COUNT(sc.story_id) as story_count 
                FROM collections c 
                LEFT JOIN story_collections sc ON c.id = sc.collection_id 
                GROUP BY c.id 
                ORDER BY c.name
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async addStoryToCollection(storyId, collectionId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR IGNORE INTO story_collections (story_id, collection_id) VALUES (?, ?)',
                [storyId, collectionId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    async removeStoryFromCollection(storyId, collectionId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM story_collections WHERE story_id = ? AND collection_id = ?',
                [storyId, collectionId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    async getStoriesInCollection(collectionId) {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT s.*, sc.added_at as added_to_collection
                FROM stories s
                JOIN story_collections sc ON s.id = sc.story_id
                WHERE sc.collection_id = ?
                ORDER BY sc.added_at DESC
            `, [collectionId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async deleteCollection(collectionId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM collections WHERE id = ?', [collectionId], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    // ===== STORY RECOMMENDATIONS =====

    async generateSimilarityKeywords(content, title, author) {
        // Extract keywords from content for similarity matching
        const text = `${title} ${author} ${content}`.toLowerCase();
        
        // Remove common words and extract meaningful terms
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them']);
        
        const words = text.match(/\b\w{3,}\b/g) || [];
        const wordFreq = {};
        
        words.forEach(word => {
            if (!stopWords.has(word)) {
                wordFreq[word] = (wordFreq[word] || 0) + 1;
            }
        });
        
        // Get top keywords by frequency
        const keywords = Object.entries(wordFreq)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 20)
            .map(([word]) => word);
        
        return keywords.join(',');
    }

    async updateStorySimilarityKeywords(storyId) {
        const story = await this.getStoryById(storyId);
        if (!story) return;
        
        const keywords = await this.generateSimilarityKeywords(story.content, story.title, story.author || '');
        
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE stories SET similarity_keywords = ? WHERE id = ?',
                [keywords, storyId],
                function(err) {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    async getSimilarStories(storyId, limit = 5) {
        const story = await this.getStoryById(storyId);
        if (!story || !story.similarity_keywords) {
            return [];
        }
        
        const keywords = story.similarity_keywords.split(',');
        
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT s.*, 
                       (LENGTH(s.similarity_keywords) - LENGTH(REPLACE(s.similarity_keywords, ?, ''))) / LENGTH(?) as similarity_score
                FROM stories s
                WHERE s.id != ? 
                  AND s.similarity_keywords IS NOT NULL
                  AND (${keywords.map(() => 's.similarity_keywords LIKE ?').join(' OR ')})
                ORDER BY similarity_score DESC, s.read_count DESC
                LIMIT ?
            `, [keywords.join(','), keywords.join(','), storyId, ...keywords.map(k => `%${k}%`), limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async markStoryAsRead(storyId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE stories SET read_count = read_count + 1, last_read = CURRENT_TIMESTAMP WHERE id = ?',
                [storyId],
                function(err) {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    // ===== RSS FEED MONITORING =====

    async addRSSFeed(url, title = '', description = '') {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO rss_feeds (url, title, description) VALUES (?, ?, ?)',
                [url, title, description],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID, url, title, description });
                }
            );
        });
    }

    async getAllRSSFeeds() {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT rf.*, COUNT(ri.id) as item_count, 
                       COUNT(CASE WHEN ri.scraped = 1 THEN 1 END) as scraped_count
                FROM rss_feeds rf
                LEFT JOIN rss_items ri ON rf.id = ri.feed_id
                GROUP BY rf.id
                ORDER BY rf.created_at DESC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async checkRSSFeed(feedId) {
        const feed = await new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM rss_feeds WHERE id = ?', [feedId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!feed) throw new Error('Feed not found');

        try {
            // Use fetch to get RSS content
            const response = await fetch(feed.url);
            const xmlText = await response.text();
            
            // Parse RSS/XML (basic parsing)
            const items = this.parseRSSItems(xmlText);
            
            let newItems = 0;
            for (const item of items) {
                const added = await this.addRSSItem(feedId, item);
                if (added) newItems++;
            }

            // Update feed last_checked
            await new Promise((resolve, reject) => {
                this.db.run(
                    'UPDATE rss_feeds SET last_checked = CURRENT_TIMESTAMP WHERE id = ?',
                    [feedId],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            return { newItems, totalItems: items.length };
        } catch (error) {
            console.error(`Error checking RSS feed ${feed.url}:`, error);
            throw error;
        }
    }

    parseRSSItems(xmlText) {
        // Basic RSS parsing - in production, use a proper XML parser like 'xml2js'
        const items = [];
        const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
        let match;

        while ((match = itemRegex.exec(xmlText)) !== null) {
            const itemXml = match[1];
            
            const title = this.extractXMLTag(itemXml, 'title');
            const link = this.extractXMLTag(itemXml, 'link');
            const description = this.extractXMLTag(itemXml, 'description');
            const pubDate = this.extractXMLTag(itemXml, 'pubDate');

            if (title && link) {
                items.push({
                    title: this.cleanXMLContent(title),
                    url: this.cleanXMLContent(link),
                    description: this.cleanXMLContent(description),
                    pubDate: pubDate ? new Date(pubDate) : new Date()
                });
            }
        }

        return items;
    }

    extractXMLTag(xml, tagName) {
        const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
        const match = xml.match(regex);
        return match ? match[1] : '';
    }

    cleanXMLContent(content) {
        return content
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]+>/g, '')
            .trim();
    }

    async addRSSItem(feedId, item) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR IGNORE INTO rss_items (feed_id, title, url, description, pub_date) VALUES (?, ?, ?, ?, ?)',
                [feedId, item.title, item.url, item.description, item.pubDate],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    async getUnscrapedRSSItems(limit = 10) {
        return new Promise((resolve, reject) => {
            this.db.all(`
                SELECT ri.*, rf.title as feed_title
                FROM rss_items ri
                JOIN rss_feeds rf ON ri.feed_id = rf.id
                WHERE ri.scraped = 0
                ORDER BY ri.pub_date DESC
                LIMIT ?
            `, [limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async markRSSItemAsScraped(itemId, storyId = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE rss_items SET scraped = 1, story_id = ? WHERE id = ?',
                [storyId, itemId],
                function(err) {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    }

    async scrapeRSSItems(limit = 5) {
        const items = await this.getUnscrapedRSSItems(limit);
        const results = [];

        for (const item of items) {
            try {
                console.log(`Scraping RSS item: ${item.title}`);
                const story = await this.scrape(item.url);
                
                // Update similarity keywords
                const storyId = await this.getStoryIdByUrl(item.url);
                if (storyId) {
                    await this.updateStorySimilarityKeywords(storyId);
                }
                
                // Mark as scraped
                await this.markRSSItemAsScraped(item.id, storyId);
                
                results.push({ success: true, item, story });
            } catch (error) {
                console.error(`Failed to scrape RSS item ${item.title}:`, error);
                results.push({ success: false, item, error: error.message });
            }
        }

        return results;
    }

    async getStoryIdByUrl(url) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT id FROM stories WHERE url = ?', [url], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.id : null);
            });
        });
    }

    async deleteRSSFeed(feedId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM rss_feeds WHERE id = ?', [feedId], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    // ===== ENHANCED SEARCH =====

    async searchStories(query, options = {}) {
        const {
            searchContent = true,
            searchTitle = true,
            searchAuthor = true,
            collectionId = null,
            minWordCount = null,
            maxWordCount = null,
            domain = null,
            limit = 50
        } = options;

        let sql = 'SELECT * FROM stories WHERE 1=1';
        const params = [];

        // Build search conditions
        if (query && query.trim()) {
            const searchConditions = [];
            const searchTerm = `%${query.trim()}%`;

            if (searchTitle) {
                searchConditions.push('title LIKE ?');
                params.push(searchTerm);
            }
            if (searchAuthor) {
                searchConditions.push('author LIKE ?');
                params.push(searchTerm);
            }
            if (searchContent) {
                searchConditions.push('content LIKE ?');
                params.push(searchTerm);
            }

            if (searchConditions.length > 0) {
                sql += ` AND (${searchConditions.join(' OR ')})`;
            }
        }

        // Add filters
        if (collectionId) {
            sql += ` AND id IN (SELECT story_id FROM story_collections WHERE collection_id = ?)`;
            params.push(collectionId);
        }

        if (minWordCount) {
            sql += ` AND word_count >= ?`;
            params.push(minWordCount);
        }

        if (maxWordCount) {
            sql += ` AND word_count <= ?`;
            params.push(maxWordCount);
        }

        if (domain) {
            sql += ` AND domain LIKE ?`;
            params.push(`%${domain}%`);
        }

        sql += ` ORDER BY scraped_at DESC LIMIT ?`;
        params.push(limit);

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async close() {
        if (this.browser) await this.browser.close();
        if (this.db) this.db.close();
        console.log('Enhanced scraper closed');
    }
}

module.exports = EnhancedStoryScraper;