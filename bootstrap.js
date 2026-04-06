const loadConfig = require('./config/env');

(async () => {
  const config = await loadConfig();

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