'use strict';

/**
 * spacetag service.
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::spacetag.spacetag');

