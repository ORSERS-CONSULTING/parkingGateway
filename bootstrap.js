const loadConfig = require('./config/env');

(async () => {
    const config = await loadConfig();

    console.log("\n===== LOADED CONFIG =====");
    console.log({
        PORT: config.PORT,
        LOCAL_IP: config.LOCAL_IP,
        APEX_URL: config.APEX_URL,
        HIK_HOST: config.HIK_HOST ? "✔ loaded" : "❌ missing",
        APPKEY: config.APPKEY ? "✔ loaded" : "❌ missing",
        APPSECRET: config.APPSECRET ? "✔ loaded" : "❌ missing",
        CLIENT_ID: config.CLIENT_ID ? "✔ loaded" : "❌ missing",
        CLIENT_SECRET: config.CLIENT_SECRET ? "✔ loaded" : "❌ missing",
        IDCS_TENANT: config.IDCS_TENANT ? "✔ loaded" : "❌ missing",
    });
    console.log("=========================\n");

    process.env.PORT = config.PORT;
    process.env.HIK_HOST = config.HIK_HOST;
    process.env.LOCAL_IP = config.LOCAL_IP;
    process.env.APEX_URL = config.APEX_URL;
    process.env.APPKEY = config.APPKEY;
    process.env.APPSECRET = config.APPSECRET;
    process.env.CLIENT_ID = config.CLIENT_ID;
    process.env.CLIENT_SECRET = config.CLIENT_SECRET;
    process.env.IDCS_TENANT = config.IDCS_TENANT;

    require('./index');
})();