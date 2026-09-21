import { json } from '@sveltejs/kit';
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import { DISCORD_PUBLIC_KEY } from '$env/static/private';
import axios from 'axios';

function buildOpenDotaRecentMatchesUrl(accountId) {
	return `https://api.opendota.com/api/players/${encodeURIComponent(accountId)}/recentMatches`;
}

function buildDiscordWebhookUrl(applicationId, token) {
	return `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;
}

export async function POST({ request, platform }) {
	const signature = request.headers.get('x-signature-ed25519');
	const timestamp = request.headers.get('x-signature-timestamp');
	const rawBody = await request.text();

	if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
		return new Response('Required signature validation metadata missing', { status: 401 });
	}

	const isValidRequest = verifyKey(rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
	if (!isValidRequest) {
		return new Response('Invalid request signature verification failed', { status: 401 });
	}

	const interaction = JSON.parse(rawBody);

	if (interaction.type === InteractionType.PING) {
		return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (interaction.type === InteractionType.APPLICATION_COMMAND) {
		const name = interaction.data?.name;
		const options = interaction.data?.options;
		const token = interaction.token;
		const applicationId = interaction.application_id;

		if (name === 'match') {
			const accountId = options?.[0]?.value;

			if (!accountId) {
				return json({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: 'Please provide a valid Dota 2 Account ID.' }
				});
			}

			if (platform && typeof platform.waitUntil === 'function') {
				platform.waitUntil(fetchAndSendMatchData(accountId, token, applicationId));
			} else {
				fetchAndSendMatchData(accountId, token, applicationId);
			}

			return json({
				type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
			});
		}
	}

	return json({ error: 'Unknown interaction command variant' }, { status: 400 });
}

async function fetchAndSendMatchData(accountId, token, applicationId) {
	const followUpUrl = buildDiscordWebhookUrl(applicationId, token);

	try {
		const response = await axios.get(buildOpenDotaRecentMatchesUrl(accountId));
		const recentMatches = response.data;
		const latestMatch =
			Array.isArray(recentMatches) && recentMatches.length > 0 ? recentMatches[0] : null;

		if (!latestMatch) {
			await axios.post(
				followUpUrl,
				{ content: `No recent matches found for account ID: ${accountId}` },
				{ headers: { 'Content-Type': 'application/json' } }
			);
			return;
		}

		const isRadiant = latestMatch.player_slot < 128;
		const isWin =
			(isRadiant && latestMatch.radiant_win) || (!isRadiant && !latestMatch.radiant_win);
		const resultText = isWin ? '🏆 Won' : '❌ Lost';

		await axios.post(
			followUpUrl,
			{
				embeds: [
					{
						title: `Latest Match Result - Match ${latestMatch.match_id}`,
						color: isWin ? 0x2ecc71 : 0xe74c3c,
						fields: [
							{ name: 'Result', value: resultText, inline: true },
							{
								name: 'K/D/A',
								value: `${latestMatch.kills}/${latestMatch.deaths}/${latestMatch.assists}`,
								inline: true
							},
							{ name: 'Duration', value: `${Math.floor(latestMatch.duration / 60)}m`, inline: true }
						]
					}
				]
			},
			{ headers: { 'Content-Type': 'application/json' } }
		);
	} catch (error) {
		console.error('Background OpenDota processing failure:', error.response?.data || error.message);
		try {
			await axios.post(
				followUpUrl,
				{ content: 'Failed to fetch match data from OpenDota.' },
				{ headers: { 'Content-Type': 'application/json' } }
			);
		} catch (webhookError) {
			console.error(
				'Webhook fallback delivery failed:',
				webhookError.response?.data || webhookError.message
			);
		}
	}
}

