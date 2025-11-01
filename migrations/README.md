# Contentful to Strapi Migration Scripts

This directory contains migration scripts to migrate content from Contentful to Strapi.

## Overview

The migration follows a strict sequence of execution, migrating content models one at a time. Each migration script:
1. Fetches content from Contentful
2. Uploads associated media files to Strapi
3. Creates entries in Strapi with proper field mappings
4. Maintains ID mappings for relationships

## Prerequisites

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Strapi production environment:**
   
   Set environment variables or update `migrations/utils.js`:
   ```bash
   export STRAPI_URL=https://your-strapi-production-url.com
   export STRAPI_API_TOKEN=your-api-token-here
   ```
   
   Or create a `.env` file in the strapi directory:
   ```
   STRAPI_URL=https://your-strapi-production-url.com
   STRAPI_API_TOKEN=your-api-token-here
   ```

3. **Ensure Strapi content types are created:**
   
   Before running migrations, you need to create the corresponding content types in Strapi:
   - `space-tags`
   - `location-tags`
   - `magazine-tags` (renamed from journal-tags)
   - `shop-items`
   - `spaces`
   - `magazine-posts` (renamed from journals)
   - `pages`
   - `events`
   - `location-options`
   - `locations`
   - `home-page` (singleton)

## Migration Sequence

The migrations must be executed in the following order:

1. **4.1 SpaceTags** - `node migrations/1-space-tags.js`
2. **4.2 LocationTags** - `node migrations/2-location-tags.js`
3. **4.3 JournalTags → Magazine Tags** - `node migrations/3-journal-tags.js`
4. **4.4 ShopItems** - `node migrations/4-shop-items.js`
5. **4.5 Spaces** - `node migrations/5-spaces.js` (requires SpaceTags)
6. **4.6 Journals → Magazine Posts** - `node migrations/6-journals.js` (requires Magazine Tags)
7. **4.7 Pages** - `node migrations/7-pages.js`
8. **4.8 Events** - `node migrations/8-events.js`
9. **4.9 LocationOptions** - `node migrations/9-location-options.js`
10. **4.10 Locations** - `node migrations/10-locations.js` (requires LocationTags, Spaces, LocationOptions)
11. **4.11 HomePage** - `node migrations/11-home-page.js` (singleton, requires ShopItems)

## Field Mappings

The migration scripts follow these field mapping rules:

- **Text (Short/Long)** → Strapi: Text field (Short text for titles/slugs, Long text for descriptions)
- **Rich Text** → Strapi: Rich Text (Blocks)
- **Number** → Strapi: Number
- **Date & Time** → Strapi: Date field (DateTime)
- **Location** → Strapi: JSON field (lat/lon)
- **Media (Image/Video/File)** → Strapi: Media field (single or multiple)
- **Boolean** → Strapi: Boolean
- **JSON** → Strapi: JSON
- **Reference** → Strapi: Relation field (one-to-one, one-to-many, or many-to-many)

## Usage

### Running Individual Migrations

Execute migrations one at a time, waiting for confirmation before proceeding:

```bash
# Step 1: Migrate SpaceTags
node migrations/1-space-tags.js

# After confirming success, proceed to step 2
node migrations/2-location-tags.js

# Continue with each migration in sequence...
```

### Running from Strapi Directory

All migration scripts should be run from the strapi directory:

```bash
cd strapi
node migrations/1-space-tags.js
```

## Important Notes

1. **Production Environment Only:** All migrations upload directly to production Strapi instance. No localhost.

2. **Sequential Execution:** Only proceed to the next migration after confirming the current one completed successfully.

3. **Media Uploads:** Media files are uploaded as part of each collection migration to prevent relationship loss.

4. **ID Mappings:** Some migrations depend on ID mappings from previous migrations. The scripts handle this through function parameters.

5. **Rate Limiting:** Scripts include built-in delays between requests to avoid overwhelming the Strapi API.

6. **Error Handling:** Each migration script logs errors but continues processing. Check the output for any failed entries.

## Troubleshooting

### API Authentication Errors

Ensure your `STRAPI_API_TOKEN` is valid and has proper permissions.

### Content Type Not Found

Ensure the content type exists in Strapi before running the migration. Content types must be created manually through Strapi admin panel or via schema files.

### Missing Relationships

If relationships are not working:
- Verify that dependent migrations completed successfully
- Check that IDs are being mapped correctly
- Ensure content types exist and relationships are configured in Strapi

### Media Upload Failures

If media uploads fail:
- Check network connectivity
- Verify Strapi media library permissions
- Ensure temporary directory (`.temp`) has write permissions

## Output

Each migration script provides:
- Progress indicators for each entry
- Success/error counts
- ID mappings (for debugging)
- Final summary

## Support

For issues or questions, refer to:
- [Strapi Documentation](https://docs.strapi.io)
- [Contentful Documentation](https://www.contentful.com/developers/docs/)

