<script lang="ts">
import SetupGuide from './SetupGuide.svelte';
import SetupServerUrl from './SetupServerUrl.svelte';

let {
	serverUrl,
	serverOnline,
	onurlchange,
}: {
	serverUrl: string;
	serverOnline: boolean;
	onurlchange: (url: string) => void;
} = $props();
</script>

<div class="setup">
	<SetupServerUrl {serverUrl} {serverOnline} {onurlchange} />
	<SetupGuide />
</div>

<style>
.setup {
	background: var(--surface-2);
	border: 1px solid var(--border-dim);
	border-radius: 10px;
	margin-bottom: 36px;
	overflow: hidden;
}
</style>
