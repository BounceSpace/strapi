'use strict';

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
    const journals = await strapi.db.query('api::journal.journal').findMany({
      where: {
        publicationDate: null,
      },
    });

    if (journals.length > 0) {
      strapi.log.info(`Found ${journals.length} journals without publication date. Updating...`);
      
      for (const journal of journals) {
        // Use created date, or today if somehow created date is missing
        const publicationDate = journal.createdAt ? new Date(journal.createdAt) : new Date();
        
        await strapi.db.query('api::journal.journal').update({
          where: { id: journal.id },
          data: {
            publicationDate: publicationDate,
          },
        });
      }
      
      strapi.log.info('Completed migration of publication dates for journals.');
    }
  },
};
