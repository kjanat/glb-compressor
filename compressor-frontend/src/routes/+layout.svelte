<script lang="ts">
	if (
		__GITHUB_PAGES__ &&
		location.protocol === 'https:' &&
		location.hostname === 'glb-compressor.kjanat.com'
	)
		location.replace(location.href.replace('https:', 'http:'));

	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon}></svelte:head>
{@render children()}
