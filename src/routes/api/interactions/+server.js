import { json } from '@sveltejs/kit';
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import { DISCORD_PUBLIC_KEY } from '\$env/static/private';
import axios from 'axios';
import { Buffer } from 'node:buffer';

export async function POST({ request, platform }) {
	// 1. Grab headers explicitly using lowercased naming conventions
	const signature = request.headers.get('x-signature-ed25519');
	const timestamp = request.headers.get('x-signature-timestamp');
	const rawBody = await request.text();

	if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
		return new Response('Required signature validation metadata missing', { status: 401 });
	}

	// 2. Perform raw payload verification
	const isValidRequest = await verifyKey(Buffer.from(rawBody), signature, timestamp, DISCORD_PUBLIC_KEY);

	console.log({
		hasSignature: !!signature,
		hasTimestamp: !!timestamp,
		publicKeySet: !!DISCORD_PUBLIC_KEY
	});

	if (!isValidRequest) {
		return new Response('Invalid request signature signature verification failed', { status: 401 });
	}

	const interaction = JSON.parse(rawBody);

	// 3. Handle Discord's validation check upfront cleanly
	if (interaction.type === InteractionType.PING) {
		// Return a raw 200 payload containing the standard PONG value (type: 1)
		return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// 4. Handle Slash Commands
	if (interaction.type === InteractionType.APPLICATION_COMMAND) {
		const name = interaction.data?.name;
		const options = interaction.data?.options;
		const token = interaction.token;
		const application_id = interaction.application_id;

		if (name === 'match') {
			const accountIdOption = options?.find(
				(opt) => opt.name === 'account_id' || opt.type === 3 || opt.type === 4
			);
			const accountId = accountIdOption ? accountIdOption.value : options?.[0]?.value;

			if (!accountId) {
				return json({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: 'Please provide a valid Dota 2 Account ID.' }
				});
			}

			// Keep lambda function tracking process instance running out of band
			if (platform && typeof platform.waitUntil === 'function') {
				platform.waitUntil(fetchAndSendMatchData(accountId, token, application_id));
			} else {
				fetchAndSendMatchData(accountId, token, application_id);
			}

			return json({
				type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
			});
		}
	}

	return json({ error: 'Unknown interaction command variant' }, { status: 400 });
}

// Separate asynchronous processing function
async function fetchAndSendMatchData(accountId, token, applicationId) {
	const followUpUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;

	try {
		const response = await axios.get(`https://opendota.com/${accountId}/recentMatches`);
		const recentMatches = response.data;

		// Grab item index 0 from recent matches safely
		const latestMatch =
			Array.isArray(recentMatches) && recentMatches.length > 0 ? recentMatches[0] : null;

		if (!latestMatch) {
			await axios.post(followUpUrl, {
				content: `No recent matches found for account ID: ${accountId}`
			});
			return;
		}

		const isRadiant = latestMatch.player_slot < 128;
		const isWin =
			(isRadiant && latestMatch.radiant_win) || (!isRadiant && !latestMatch.radiant_win);
		const resultText = isWin ? '🏆 Won' : '❌ Lost';

		await axios.post(followUpUrl, {
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
		});
	} catch (error) {
		console.error('Background OpenDota processing failure:', error.response?.data || error.message);
		try {
			await axios.post(followUpUrl, {
				content: 'Failed to fetch match data from OpenDota.'
			});
		} catch (webhookError) {
			console.error(
				'Webhook fallback delivery failed:',
				webhookError.response?.data || webhookError.message
			);
		}
	}
}
