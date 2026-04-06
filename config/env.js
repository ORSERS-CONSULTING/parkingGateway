require("dotenv").config();
const { getSecret } = require("./vault");



const required = async (name, vaultOcidEnvVar) => {

  if (process.env[name]) {
    return process.env[name];
  }
  // 2. Otherwise, try fetching from OCI Vault
  const secretOcid = process.env[vaultOcidEnvVar];
  if (secretOcid) {
    return await getSecret(secretOcid);
  }

  throw new Error(`Missing config: ${name}`);
};

async function loadConfig() {
  return {
    PORT: process.env.PORT || 3000,  // <— add this line
    LOCAL_IP: process.env.LOCAL_IP,  // <— add this line
    APEX_URL: process.env.APEX_URL,  // <— add this line
    HIK_HOST: await required("HIK_HOST", "HIK_HOST_OCID"),
    APPKEY: await required("APPKEY", "APPKEY_OCID"),
    APPSECRET: await required("APPSECRET", "APPSECRET_OCID"),
    CLIENT_ID: await required("CLIENT_ID", "CLIENT_ID_OCID"),
    CLIENT_SECRET: await required("CLIENT_SECRET", "CLIENT_SECRET_OCID"),
    IDCS_TENANT: await required("IDCS_TENANT", "IDCS_TENANT_OCID"),

  };
}

module.exports = loadConfig;
