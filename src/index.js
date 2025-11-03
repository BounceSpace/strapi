'use strict';

// Helper function to trigger Netlify build
async function triggerNetlifyBuild(buildHook, strapi) {
  if (!buildHook) {
    strapi.log.warn('Netlify build hook not configured');
    return;
  }

  try {
    // Use Node's built-in fetch (available in Node 18+)
    const response = await fetch(buildHook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      strapi.log.info(`Netlify build triggered successfully: ${buildHook}`);
    } else {
      strapi.log.error(`Netlify build hook returned status ${response.status}`);
    }
  } catch (error) {
    strapi.log.error(`Failed to trigger Netlify build: ${error.message}`);
  }
}

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    // Get the build hook from environment or plugin config
    const buildHook = process.env.NETLIFY_BUILD_HOOK || 
      (strapi.plugin('netlify-deployments')?.config?.sites?.[0]?.buildHook);

    if (!buildHook) {
      strapi.log.warn('Netlify build hook not found. Automatic deployments will not work.');
      return;
    }

    strapi.log.info(`Netlify build hook configured: ${buildHook}`);

    // Trigger Netlify build when content is published
    // Listen to lifecycle events for all content types
    strapi.db.lifecycles.subscribe({
      models: [
        'api::journal.journal',
        'api::event.event', 
        'api::location.location', 
        'api::page.page', 
        'api::shopitem.shopitem', 
        'api::homepage.homepage'
      ],
      
      async afterUpdate(event) {
        const { model, result } = event;
        
        // Only trigger if the entry is published
        if (result.publishedAt) {
          strapi.log.info(`Published ${model} entry detected: ${result.id}`);
          await triggerNetlifyBuild(buildHook, strapi);
        }
      },
      
      async afterCreate(event) {
        const { model, result } = event;
        
        // Only trigger if the entry is published immediately
        if (result.publishedAt) {
          strapi.log.info(`Published ${model} entry created: ${result.id}`);
          await triggerNetlifyBuild(buildHook, strapi);
        }
      },
    });

    strapi.log.info('Netlify automatic deployment hook initialized');
  },
};
