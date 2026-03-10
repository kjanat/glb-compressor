<script lang="ts">
	let { onfiles }: { onfiles: (files: File[]) => void } = $props();

	let dragOver = $state(false);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<label
	class="dropzone"
	class:dragover={dragOver}
	ondragover={(e) => {
		e.preventDefault();
		dragOver = true;
	}}
	ondragleave={() => (dragOver = false)}
	ondrop={(e) => {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files.length) onfiles(Array.from(e.dataTransfer.files));
	}}
>
	<input
		type="file"
		accept=".glb, .gltf"
		multiple
		onchange={(e) => {
			const input = e.currentTarget;
			if (input.files?.length) onfiles(Array.from(input.files));
			input.value = '';
		}}
	>
	<span class="drop-icon">&#128230;</span>
	<p class="drop-title">Drop your GLB files here</p>
	<p class="drop-sub">
		or click to browse &ndash; .glb / .gltf &ndash; multiple files OK
	</p>
</label>

<style>
	.dropzone {
		display: block;
		width: 100%;
		border: 2px dashed var(--border);
		border-radius: 8px;
		padding: 48px 24px;
		text-align: center;
		cursor: pointer;
		transition: border-color 0.2s, background 0.2s;
		position: relative;
		margin-bottom: 24px;
	}
	.dropzone:hover,
	.dropzone.dragover {
		border-color: var(--accent);
		background: var(--accent-bg);
	}
	.dropzone input[type="file"] {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
		width: 100%;
		height: 100%;
	}
	.drop-icon {
		font-size: 40px;
		margin-bottom: 12px;
		display: block;
	}
	.drop-title {
		font-size: 18px;
		font-weight: 600;
		margin-bottom: 6px;
	}
	.drop-sub {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
	}
</style>
