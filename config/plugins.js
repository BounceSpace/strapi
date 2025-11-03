module.exports = ({ env }) => ({
  "netlify-deployments": {
    enabled: true,
    config: {
      accessToken: process.env.NETLIFY_DEPLOYMENTS_PLUGIN_ACCESS_TOKEN || env("NETLIFY_DEPLOYMENTS_PLUGIN_ACCESS_TOKEN"),
      sites: [
        {
          name: env("NETLIFY_SITE_NAME") || "bouncespace.co",
          id: env("NETLIFY_SITE_ID"),
          buildHook: env("NETLIFY_BUILD_HOOK"),
          branch: env("NETLIFY_BRANCH") || "master",
        },
      ],
    },
  },
});
