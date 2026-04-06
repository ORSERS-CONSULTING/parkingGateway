// config/vault.js
const {
  InstancePrincipalsAuthenticationDetailsProviderBuilder
} = require("oci-common");
const { SecretsClient } = require("oci-secrets");

async function getSecret(secretOcid) {
  console.log(">>> getSecret called with:", secretOcid);
  if (!secretOcid) throw new Error("secret OCID missing");

  // Build Instance Principals provider (VMs)
  const provider = await new InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
console.log(">>> provider built");
  const client = new SecretsClient({ authenticationDetailsProvider: provider });
  client.regionId = "me-dubai-1";
  console.log(">>> client region:", client.regionId);

  const { secretBundle } = await client.getSecretBundle({
    secretId: secretOcid,
    stage: "CURRENT",
  });

  console.log(">>> secret bundle fetched successfully");
  const b64 = secretBundle.secretBundleContent.content; // Base64-encoded
  return Buffer.from(b64, "base64").toString("utf8");
}

module.exports = { getSecret };


