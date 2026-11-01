// Prints which install the account's Worker sub2api runs now: "container", "worker" or "none".
// Both installs deploy under that one name, so the deploy workflows ask this first and only ever
// update the install that is already there. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
if (token === "" || account === "") {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(64);
}

const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/sub2api/settings`, {
  headers: { authorization: `Bearer ${token}` },
});
if (response.status === 404) {
  console.log("none");
  process.exit(0);
}
const body = await response.json().catch(() => null);
if (!response.ok || body?.success !== true) {
  console.error(`Cloudflare answered ${response.status} when asked about the Worker sub2api.`);
  process.exit(1);
}
const classes = (body.result?.bindings ?? []).filter((binding) => binding.type === "durable_object_namespace").map((binding) => binding.class_name);
if (classes.includes("Cpa")) console.log("container");
else if (classes.includes("Store")) console.log("worker");
else {
  console.error("The Worker sub2api is neither install, so nothing is deployed over it.");
  process.exit(1);
}
