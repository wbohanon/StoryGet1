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
                        tags TEXT
                    )
                `, (err) => {
                    if (err) reject(err);
                    else {
                        console.log('Created new stories table with enhanced schema');
                        resolve();
                    }
                });
            });
            return;
        }

        // Migrate existing table by adding missing columns
        const requiredColumns = [
            { name: 'author', type: 'TEXT' },
            { name: 'word_count', type: 'INTEGER' },
            { name: 'domain', type: 'TEXT' },
            { name: 'tags', type: 'TEXT' }
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
                    const domain = record.url ? new URL(record.url).hostname : null;
                    const wordCount = record.content ? record.content.split(/\s+/).length : 0;

                    await new Promise((resolve, reject) => {
                        this.db.run(`
                            UPDATE stories 
                            SET word_count = ?, domain = ? 
                            WHERE id = ?
                        `, [wordCount, domain, record.id], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                } catch (error) {
                    console.log(`Warning: Could not update record ${record.id}: ${error.message}`);
                }
            }

            console.log('Database migration completed');
        }
    }

    async scrape(url) {
        console.log('Scraping:', url);
        
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
        
        await page.close();
        
        // Save to database with enhanced data
        await new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO stories (url, title, content, author, word_count, domain) VALUES (?, ?, ?, ?, ?, ?)',
                [url, title, content, author, wordCount, domain],
                function(err) {
                    if (err) reject(err);
                    else {
                        console.log('Saved story:', title);
                        resolve();
                    }
                }
            );
        });
        
        return { title, content, author, wordCount, domain };
    }

    async scrapeLinksFromPage(pageUrl, options = {}) {
        console.log('🔍 Finding story links on:', pageUrl);
        
        const {
            linkSelector = 'a[href]',
            filterPatterns = [],
            excludePatterns = ['/css/', '/js/', '/images/', '.jpg', '.png', '.gif', '.pdf', '.zip', '.exe', 'mailto:', 'tel:'],
            maxLinks = 50,
            sameDomainOnly = true,
            minContentLength = 500,
            storyKeywords = ['story', 'chapter', 'tale', 'fiction', 'novel', 'book', 'read']
        } = options;

        const page = await this.browser.newPage();
        await page.goto(pageUrl, { waitUntil: 'networkidle2' });
        
        const html = await page.content();
        const $ = cheerio.load(html);
        const baseDomain = new URL(pageUrl).hostname;
        
        // Extract all links
        const allLinks = [];
        $(linkSelector).each((i, element) => {
            const href = $(element).attr('href');
            const linkText = $(element).text().trim();
            const parentText = $(element).parent().text().trim();
            
            if (href) {
                try {
                    const fullUrl = new URL(href, pageUrl).href;
                    allLinks.push({ 
                        url: fullUrl, 
                        text: linkText,
                        parentText: parentText
                    });
                } catch (error) {
                    // Skip invalid URLs
                }
            }
        });

        // Smart filtering for story links
        let filteredLinks = allLinks.filter(link => {
            const url = link.url.toLowerCase();
            const text = (link.text + ' ' + link.parentText).toLowerCase();
            const domain = new URL(link.url).hostname;
            
            // Same domain check
            if (sameDomainOnly && domain !== baseDomain) {
                return false;
            }
            
            // Exclude common non-story patterns
            if (excludePatterns.some(pattern => url.includes(pattern.toLowerCase()))) {
                return false;
            }
            
            // Exclude navigation and common page elements
            const excludeTexts = ['home', 'about', 'contact', 'login', 'register', 'search', 'menu', 'navigation', 'footer', 'header', 'sidebar'];
            if (excludeTexts.some(exclude => text.includes(exclude) && text.length < 50)) {
                return false;
            }
            
            // Skip if link text is too short or generic
            if (link.text.length < 3 || ['more', 'click', 'here', 'link', 'page'].includes(link.text.toLowerCase())) {
                return false;
            }
            
            // Include patterns (if specified)
            if (filterPatterns.length > 0) {
                return filterPatterns.some(pattern => 
                    url.includes(pattern.toLowerCase()) || 
                    text.includes(pattern.toLowerCase())
                );
            }
            
            // Smart story detection - look for story-related keywords
            const hasStoryKeywords = storyKeywords.some(keyword => 
                url.includes(keyword) || text.includes(keyword)
            );
            
            // Prefer links with meaningful text (likely story titles)
            const hasMeaningfulText = link.text.length > 10 && link.text.length < 200;
            
            // Look for numbered chapters or parts
            const hasChapterNumbers = /chapter|part|episode|\d+/.test(text);
            
            return hasStoryKeywords || hasMeaningfulText || hasChapterNumbers;
        });

        // Remove duplicates and limit
        const uniqueLinks = [...new Map(filteredLinks.map(link => [link.url, link])).values()];
        const linksToScrape = uniqueLinks.slice(0, maxLinks);
        
        await page.close();
        
        console.log(`📊 Found ${allLinks.length} total links, filtered to ${linksToScrape.length} potential stories`);
        
        if (linksToScrape.length === 0) {
            console.log('❌ No story links found. Try adjusting filter options.');
            return {
                pageUrl,
                totalLinksFound: allLinks.length,
                linksProcessed: 0,
                results: [],
                errors: [],
                summary: { successful: 0, skipped: 0, failed: 0 }
            };
        }
        
        // Show preview of links to be scraped
        console.log('\n📋 Links to scrape:');
        linksToScrape.slice(0, 10).forEach((link, i) => {
            console.log(`  ${i + 1}. ${link.text || 'Untitled'}`);
        });
        if (linksToScrape.length > 10) {
            console.log(`  ... and ${linksToScrape.length - 10} more`);
        }
        console.log('');
        
        // Scrape each link
        const results = [];
        const errors = [];
        
        for (let i = 0; i < linksToScrape.length; i++) {
            const link = linksToScrape[i];
            
            try {
                console.log(`[${i + 1}/${linksToScrape.length}] 🔍 "${link.text || 'Untitled'}"`);
                
                // Check if already exists
                const existing = await this.getStoryByUrl(link.url);
                if (existing) {
                    console.log('  ↳ ⏭️  Already exists, skipping');
                    results.push({ url: link.url, status: 'skipped', reason: 'already_exists', linkText: link.text });
                    continue;
                }
                
                const result = await this.scrape(link.url);
                
                // Check if content is substantial enough
                if (result.content.length < minContentLength) {
                    console.log(`  ↳ ⚠️  Content too short (${result.content.length} chars), skipping`);
                    await this.deleteStoryByUrl(link.url); // Remove if we just added it
                    results.push({ url: link.url, status: 'skipped', reason: 'content_too_short', linkText: link.text });
                    continue;
                }
                
                console.log(`  ↳ ✅ Success! "${result.title}" (${result.wordCount.toLocaleString()} words)`);
                results.push({ 
                    url: link.url, 
                    status: 'success', 
                    story: result,
                    linkText: link.text
                });
                
                // Be respectful - add delay
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.log(`  ↳ ❌ Error: ${error.message}`);
                errors.push({ url: link.url, error: error.message, linkText: link.text });
            }
        }
        
        const summary = {
            successful: results.filter(r => r.status === 'success').length,
            skipped: results.filter(r => r.status === 'skipped').length,
            failed: errors.length
        };
        
        console.log('\n📈 Link scraping completed:');
        console.log(`  ✅ Successful: ${summary.successful}`);
        console.log(`  ⏭️  Skipped: ${summary.skipped}`);
        console.log(`  ❌ Failed: ${summary.failed}`);
        
        return {
            pageUrl,
            totalLinksFound: allLinks.length,
            linksProcessed: linksToScrape.length,
            results,
            errors,
            summary
        };
    }

    async getStoryByUrl(url) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM stories WHERE url = ?', [url], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async deleteStoryByUrl(url) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM stories WHERE url = ?', [url], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    extractTitle($) {
        // Try specific story/content title selectors first
        const primarySelectors = [
            'h1.story-title', 'h1.post-title', 'h1.chapter-title',
            '.story-title', '.post-title', '.chapter-title', '.entry-title',
            'h1.title', '.title h1', '#title h1',
            'article h1', 'main h1', '.content h1'
        ];
        
        for (const selector of primarySelectors) {
            const element = $(selector).first();
            if (element.length > 0) {
                const text = element.text().trim();
                if (text && text.length > 3 && text.length < 200) {
                    return this.cleanTitle(text);
                }
            }
        }
        
        // Fallback to any h1
        const h1Text = $('h1').first().text().trim();
        if (h1Text && h1Text.length > 3 && h1Text.length < 200) {
            return this.cleanTitle(h1Text);
        }
        
        // Try other heading levels
        const headingSelectors = ['h2', 'h3'];
        for (const selector of headingSelectors) {
            const text = $(selector).first().text().trim();
            if (text && text.length > 3 && text.length < 200) {
                return this.cleanTitle(text);
            }
        }
        
        // Last resort: try page title but clean it up
        const pageTitle = $('title').text().trim();
        if (pageTitle && pageTitle.length > 3) {
            const cleanedTitle = this.cleanTitle(pageTitle);
            if (cleanedTitle.length > 3 && cleanedTitle.length < 200) {
                return cleanedTitle;
            }
        }
        
        return 'Untitled Story';
    }

    extractContent($) {
        // Remove unwanted elements first
        this.removeUnwantedElements($);
        
        let bestContent = '';
        let bestScore = 0;
        
        // Primary content selectors (ordered by specificity)
        const primarySelectors = [
            'article',
            '.story-content', '.story-text', '.story-body',
            '.chapter-content', '.chapter-text', '.chapter-body',
            '.post-content', '.post-body', '.post-text',
            '.content', '.main-content',
            'main',
            '.entry-content',
            '#content',
            '.text-content'
        ];
        
        // Try primary selectors first
        for (const selector of primarySelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                elements.each((i, el) => {
                    const $el = $(el);
                    const text = $el.text().trim();
                    const score = this.scoreContentElement($el, text);
                    
                    if (score > bestScore && text.length > 100) {
                        bestContent = text;
                        bestScore = score;
                    }
                });
            }
        }
        
        // If no good content found, try paragraph-based extraction
        if (bestContent.length < 200) {
            bestContent = this.extractFromParagraphs($);
        }
        
        // Final fallback: find the largest meaningful text block
        if (bestContent.length < 200) {
            bestContent = this.findLargestTextBlock($);
        }
        
        // Clean up the content
        return this.cleanContent(bestContent);
    }

    removeUnwantedElements($) {
        // Remove common unwanted elements
        const unwantedSelectors = [
            'script', 'style', 'nav', 'header', 'footer',
            '.navigation', '.nav', '.menu', '.sidebar',
            '.advertisement', '.ad', '.ads', '.advert',
            '.social', '.share', '.sharing',
            '.comments', '.comment-section',
            '.related', '.recommended',
            '.breadcrumb', '.breadcrumbs',
            '.tags', '.tag-list',
            '.author-bio', '.author-info',
            '.newsletter', '.subscription',
            '.popup', '.modal', '.overlay'
        ];
        
        unwantedSelectors.forEach(selector => {
            $(selector).remove();
        });
    }

    scoreContentElement($el, text) {
        let score = text.length;
        
        // Bonus for paragraph count (indicates structured content)
        const paragraphs = $el.find('p').length;
        score += paragraphs * 50;
        
        // Bonus for story-related classes
        const className = $el.attr('class') || '';
        const storyKeywords = ['story', 'chapter', 'content', 'text', 'body', 'post'];
        storyKeywords.forEach(keyword => {
            if (className.includes(keyword)) {
                score += 100;
            }
        });
        
        // Penalty for navigation-like content
        const navKeywords = ['nav', 'menu', 'sidebar', 'footer', 'header'];
        navKeywords.forEach(keyword => {
            if (className.includes(keyword)) {
                score -= 200;
            }
        });
        
        // Penalty for very short lines (likely navigation)
        const lines = text.split('\n').filter(line => line.trim().length > 0);
        const avgLineLength = lines.length > 0 ? text.length / lines.length : 0;
        if (avgLineLength < 30) {
            score -= 100;
        }
        
        return score;
    }

    extractFromParagraphs($) {
        let bestContent = '';
        let bestScore = 0;
        
        // Group consecutive paragraphs
        const paragraphGroups = [];
        let currentGroup = [];
        
        $('p').each((i, el) => {
            const $el = $(el);
            const text = $el.text().trim();
            
            if (text.length > 20) {
                currentGroup.push(text);
            } else if (currentGroup.length > 0) {
                paragraphGroups.push(currentGroup);
                currentGroup = [];
            }
        });
        
        if (currentGroup.length > 0) {
            paragraphGroups.push(currentGroup);
        }
        
        // Find the best paragraph group
        paragraphGroups.forEach(group => {
            const content = group.join('\n\n');
            const score = content.length + (group.length * 20); // Bonus for more paragraphs
            
            if (score > bestScore) {
                bestContent = content;
                bestScore = score;
            }
        });
        
        return bestContent;
    }

    findLargestTextBlock($) {
        let bestContent = '';
        
        // Look for the largest meaningful text block
        $('div, section, article, main').each((i, el) => {
            const $el = $(el);
            const text = $el.text().trim();
            
            // Skip if it's likely navigation or boilerplate
            if (this.isLikelyBoilerplate($el, text)) {
                return;
            }
            
            if (text.length > bestContent.length && text.length > 100) {
                bestContent = text;
            }
        });
        
        return bestContent;
    }

    isLikelyBoilerplate($el, text) {
        const className = ($el.attr('class') || '').toLowerCase();
        const id = ($el.attr('id') || '').toLowerCase();
        
        // Check for navigation-like classes/IDs
        const boilerplateKeywords = [
            'nav', 'menu', 'sidebar', 'footer', 'header',
            'advertisement', 'ad', 'social', 'share',
            'comment', 'related', 'recommended'
        ];
        
        const hasBoilerplateKeyword = boilerplateKeywords.some(keyword => 
            className.includes(keyword) || id.includes(keyword)
        );
        
        if (hasBoilerplateKeyword) return true;
        
        // Check for very short lines (likely navigation)
        const lines = text.split('\n').filter(line => line.trim().length > 0);
        const avgLineLength = lines.length > 0 ? text.length / lines.length : 0;
        
        return avgLineLength < 20 && lines.length > 5;
    }

    cleanContent(content) {
        if (!content) return '';
        
        // Remove excessive whitespace
        content = content.replace(/\s+/g, ' ').trim();
        
        // Remove common boilerplate phrases
        const boilerplatePatterns = [
            /^(home|back to top|skip to content|menu|navigation)/i,
            /(copyright|all rights reserved|\u00a9)/i,
            /^(share|like|tweet|pin)/i
        ];
        
        boilerplatePatterns.forEach(pattern => {
            content = content.replace(pattern, '');
        });
        
        return content.trim();
    }

    extractAuthor($) {
        // Try specific author selectors
        const authorSelectors = [
            '.story-author', '.post-author', '.chapter-author',
            '.author', '.by-author', '.byline',
            '[rel="author"]', '[itemprop="author"]',
            '.author-name', '.writer', '.creator',
            'article .author', 'main .author', '.content .author'
        ];
        
        for (const selector of authorSelectors) {
            const element = $(selector).first();
            if (element.length > 0) {
                const text = element.text().trim();
                if (text && text.length > 1 && text.length < 100) {
                    return this.cleanAuthor(text);
                }
            }
        }
        
        // Try meta tags
        const metaAuthor = $('meta[name="author"]').attr('content');
        if (metaAuthor && metaAuthor.trim().length > 1) {
            return this.cleanAuthor(metaAuthor.trim());
        }
        
        // Look for "by [author]" patterns in text
        const bodyText = $('body').text();
        const byPattern = /(?:^|\s)(?:by|author:|written by)\s+([a-zA-Z\s]{2,50})(?:\s|$|\.)/i;
        const match = bodyText.match(byPattern);
        if (match && match[1]) {
            const author = match[1].trim();
            if (author.length > 1 && author.length < 50) {
                return this.cleanAuthor(author);
            }
        }
        
        return null;
    }

    cleanAuthor(author) {
        if (!author) return null;
        
        // Remove common prefixes
        author = author.replace(/^(by|author:|written by|story by)\s*/i, '');
        
        // Remove common suffixes
        author = author.replace(/\s*(writes?|says?|posted|published).*$/i, '');
        
        // Remove extra whitespace and clean up
        author = author.replace(/\s+/g, ' ').trim();
        
        // Skip if it's too generic or contains unwanted patterns
        const genericPatterns = [
            /^(admin|administrator|user|guest|anonymous)$/i,
            /^(unknown|n\/a|none)$/i,
            /^\d+$/,  // Just numbers
            /^[a-z]{1,2}$/i  // Too short (1-2 letters)
        ];
        
        if (genericPatterns.some(pattern => pattern.test(author))) {
            return null;
        }
        
        return author.length > 1 && author.length < 100 ? author : null;
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
    <p>Generated on ${new Date().toLocaleDateString()} - ${stories.length} stories</p>
    
    <div class="toc">
        <h2>Table of Contents</h2>
        ${stories.map((story, index) => 
            `<p><a href="#story-${story.id}">${index + 1}. ${story.title}</a> - ${story.author || 'Unknown'}</p>`
        ).join('')}
    </div>

    ${stories.map(story => `
        <div class="story" id="story-${story.id}">
            <h2 class="story-title">${story.title}</h2>
            <div class="story-meta">
                <strong>Author:</strong> ${story.author || 'Unknown'} | 
                <strong>Source:</strong> ${story.domain} | 
                <strong>Words:</strong> ${story.word_count} | 
                <strong>Scraped:</strong> ${story.scraped_at}
            </div>
            <div class="story-content">
                ${story.content.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}
            </div>
        </div>
    `).join('')}
</body>
</html>`;

        fs.writeFileSync(filename, html);
        return { filename, count: stories.length, format: 'HTML' };
    }

    exportMarkdown(stories, filename) {
        const content = [
            '# Scraped Stories Collection',
            '',
            `Generated on ${new Date().toLocaleDateString()} - ${stories.length} stories`,
            '',
            '## Table of Contents',
            '',
            ...stories.map((story, index) => 
                `${index + 1}. [${story.title}](#${story.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}) - ${story.author || 'Unknown'}`
            ),
            '',
            '---',
            '',
            ...stories.map(story => [
                `## ${story.title}`,
                '',
                `**Author:** ${story.author || 'Unknown'}  `,
                `**Source:** ${story.domain}  `,
                `**Words:** ${story.word_count}  `,
                `**Scraped:** ${story.scraped_at}  `,
                `**URL:** ${story.url}`,
                '',
                story.content,
                '',
                '---',
                ''
            ].join('\n'))
        ].join('\n');

        fs.writeFileSync(filename, content);
        return { filename, count: stories.length, format: 'Markdown' };
    }

    exportEPUB(stories, filename) {
        // Simple EPUB structure (basic implementation)
        const simpleEpub = [
            'EPUB-like Structure for Scraped Stories',
            '=' .repeat(50),
            '',
            ...stories.map((story, index) => [
                `Chapter ${index + 1}: ${story.title}`,
                `Author: ${story.author || 'Unknown'}`,
                '',
                story.content,
                '',
                '=' .repeat(50),
                ''
            ].join('\n'))
        ].join('\n');

        fs.writeFileSync(filename, simpleEpub);
        return { filename, count: stories.length, format: 'EPUB-like' };
    }

    // Debug method to help troubleshoot content extraction
    async debugScrape(url) {
        console.log('🔍 Debug scraping:', url);
        
        const page = await this.browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });
        
        const html = await page.content();
        const $ = cheerio.load(html);
        
        console.log('\n📊 Debug Information:');
        console.log('='.repeat(50));
        
        // Debug title extraction
        console.log('\n🏷️  TITLE EXTRACTION:');
        const primarySelectors = [
            'h1.story-title', 'h1.post-title', 'h1.chapter-title',
            '.story-title', '.post-title', '.chapter-title', '.entry-title',
            'h1.title', '.title h1', '#title h1',
            'article h1', 'main h1', '.content h1'
        ];
        
        primarySelectors.forEach(selector => {
            const element = $(selector).first();
            if (element.length > 0) {
                const text = element.text().trim();
                console.log(`  ✓ ${selector}: "${text}" (${text.length} chars)`);
            }
        });
        
        const h1Text = $('h1').first().text().trim();
        if (h1Text) {
            console.log(`  ✓ First h1: "${h1Text}" (${h1Text.length} chars)`);
        }
        
        const pageTitle = $('title').text().trim();
        if (pageTitle) {
            console.log(`  ✓ Page title: "${pageTitle}" (${pageTitle.length} chars)`);
        }
        
        // Debug content extraction
        console.log('\n📄 CONTENT EXTRACTION:');
        const contentSelectors = [
            'article', '.story-content', '.story-text', '.story-body',
            '.chapter-content', '.chapter-text', '.chapter-body',
            '.post-content', '.post-body', '.post-text',
            '.content', '.main-content', 'main', '.entry-content', '#content'
        ];
        
        contentSelectors.forEach(selector => {
            const element = $(selector).first();
            if (element.length > 0) {
                const text = element.text().trim();
                const preview = text.substring(0, 100) + (text.length > 100 ? '...' : '');
                console.log(`  ✓ ${selector}: ${text.length} chars - "${preview}"`);
            }
        });
        
        // Debug author extraction
        console.log('\n👤 AUTHOR EXTRACTION:');
        const authorSelectors = [
            '.story-author', '.post-author', '.chapter-author',
            '.author', '.by-author', '.byline',
            '[rel="author"]', '[itemprop="author"]',
            '.author-name', '.writer', '.creator'
        ];
        
        authorSelectors.forEach(selector => {
            const element = $(selector).first();
            if (element.length > 0) {
                const text = element.text().trim();
                console.log(`  ✓ ${selector}: "${text}"`);
            }
        });
        
        const metaAuthor = $('meta[name="author"]').attr('content');
        if (metaAuthor) {
            console.log(`  ✓ Meta author: "${metaAuthor}"`);
        }
        
        // Show paragraph count and structure
        console.log('\n📝 CONTENT STRUCTURE:');
        const paragraphs = $('p');
        console.log(`  • Paragraphs found: ${paragraphs.length}`);
        
        if (paragraphs.length > 0) {
            const totalPText = paragraphs.map((i, el) => $(el).text().trim()).get().join(' ');
            console.log(`  • Total paragraph text: ${totalPText.length} chars`);
            console.log(`  • First paragraph: "${paragraphs.first().text().trim().substring(0, 100)}..."`);
        }
        
        // Show div structure
        const divs = $('div');
        console.log(`  • Divs found: ${divs.length}`);
        
        // Show largest text blocks
        console.log('\n📊 LARGEST TEXT BLOCKS:');
        const textBlocks = [];
        $('div, section, article, main, p').each((i, el) => {
            const $el = $(el);
            const text = $el.text().trim();
            if (text.length > 100) {
                textBlocks.push({
                    tag: el.tagName.toLowerCase(),
                    class: $el.attr('class') || '',
                    id: $el.attr('id') || '',
                    length: text.length,
                    preview: text.substring(0, 100) + '...'
                });
            }
        });
        
        textBlocks
            .sort((a, b) => b.length - a.length)
            .slice(0, 5)
            .forEach((block, i) => {
                console.log(`  ${i + 1}. <${block.tag}${block.class ? ` class="${block.class}"` : ''}${block.id ? ` id="${block.id}"` : ''}> - ${block.length} chars`);
                console.log(`     "${block.preview}"`);
            });
        
        await page.close();
        
        // Now run the actual extraction
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

    async close() {
        if (this.browser) await this.browser.close();
        if (this.db) this.db.close();
        console.log('Enhanced scraper closed');
    }
}

module.exports = EnhancedStoryScraper;
