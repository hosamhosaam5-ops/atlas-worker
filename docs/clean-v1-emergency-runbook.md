# ATLAS Clean v1 Emergency Kill Switch

## Purpose and scope

This procedure removes only the Cloudflare Worker whose exact script name is \`atlas-clean-v1\`. It does not delete or modify \`atlas-worker\`, D1 databases, routes, secrets, or the shared \`wrangler.toml\`.

The automated kill switch is intentionally not tested against a live Worker. Its trigger remains disarmed until the owner explicitly arms it.

## Automated emergency stop

1. Open a dedicated PR changing only \`ops/triggers/clean-v1-production-kill.trigger\`.
2. Set the file to exactly these three lines (the third line is empty):
   \`\`\`text
   KILL
   OWNER_CONFIRMED_CLEAN_V1_KILL

   \`\`\`
3. Review the PR diff and ensure the only changed file is the kill marker. Merge only after CI passes and the owner has explicitly confirmed the emergency stop.
4. The push to \`main\` invokes \`.github/workflows/atlas-clean-v1-production-kill.yml\`. The workflow accepts only the exact three-line marker above. Any other content, including \`DISARMED\`, skips without Cloudflare calls.
5. The workflow reads Worker metadata, deletes only \`atlas-clean-v1\` if present, then performs a separate Cloudflare metadata read. It reports \`workerPresent=false\` only after that independent read confirms absence. The action log includes HTTP status and raw response data from the relevant Cloudflare responses.
6. After a successful stop, open a separate PR restoring the marker to exactly \`DISARMED\`. This closes the kill gate; it does not recreate the deleted Worker.

The workflow uses the existing \`CF_TRIAL_API_TOKEN\` secret. Cloudflare documents the delete endpoint as requiring one of: \`Workers Scripts Write\`, \`Workers Admin\`, or \`Individual Workers Admin\`. The metadata list read accepts a read-capable Workers role. A 401/403 or any unconfirmed delete stops the workflow; it does not retry. The workflow does not set the force-delete option.

## Manual fallback in Cloudflare Dashboard

1. Sign in to the Cloudflare Dashboard and select the ATLAS account.
2. Open **Workers & Pages** and locate the Worker named exactly \`atlas-clean-v1\`.
3. Confirm the selected script name before taking action. Do not select \`atlas-worker\`.
4. Use the Worker’s **Delete** action and confirm the dashboard prompt.
5. Return to Workers & Pages and verify that \`atlas-clean-v1\` is absent.

This manual fallback is a destructive operation and must be performed only under the owner’s explicit emergency decision.

## Re-deploying Clean v1 later

1. Confirm that the isolated source and \`wrangler.clean-v1.toml\` remain the approved deployment target. The config names \`atlas-clean-v1\` and points to \`src/clean-v1/worker.js\`.
2. Ensure the required pre-existing HTTPS route/base URL is already attached and the repository variable \`CLEAN_V1_PROD_BASE_URL\` (or the manually supplied workflow input) contains that owner-managed URL. The deployment workflow does not create or change routes.
3. Open a PR changing only \`ops/triggers/clean-v1-production.trigger\` to the exact three-line value:
   \`\`\`text
   RUN
   OWNER_CONFIRMED_CLEAN_V1_WALLET

   \`\`\`
4. Confirm the receiving wallet separately with the owner. The workflow’s read-only preflight must pass before the deployment job can run.
5. Merge after CI is green and the exact merge message and SHA are reviewed. The deployment is restricted to \`atlas-clean-v1\` through \`wrangler.clean-v1.toml\`.
6. After the deployment/verification sequence completes, restore the production marker to exactly \`DISARMED\` using a separate PR. This disarms future marker-triggered actions; it does not delete the published Worker.

The existing manual rollback workflow remains unchanged. It restores an explicitly selected prior version; it is not the emergency deletion mechanism described here.
