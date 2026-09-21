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

function buildHeroAssetUrl(heroName) {
	const normalized = heroName.replace('npc_dota_hero_', '').toLowerCase();
	return `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${normalized}.png`;
}

function formatHeroName(heroName) {
	return heroName
		.replace('npc_dota_hero_', '')
		.split('_')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

export async function POST({ request }) {
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
		const accountId = options?.[0]?.value;

		if (name === 'match') {
			if (!accountId) {
				return json({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: 'Please provide a valid Dota 2 Account ID.' }
				});
			}

			console.log('Slash command received', {
				accountId,
				applicationId: interaction.application_id,
				openDotaUrl: buildOpenDotaRecentMatchesUrl(accountId)
			});

			try {
				const [recentMatchesResponse, heroStatsResponse] = await Promise.all([
					axios.get(buildOpenDotaRecentMatchesUrl(accountId)),
					axios.get('https://api.opendota.com/api/herostats')
				]);

				const recentMatches = recentMatchesResponse.data;
				const heroStats = heroStatsResponse.data;
				const latestMatch =
					Array.isArray(recentMatches) && recentMatches.length > 0 ? recentMatches[0] : null;

				if (!latestMatch) {
					return json({
						type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
						data: { content: `No recent matches found for account ID: ${accountId}` }
					});
				}

				const hero = heroStats.find((entry) => entry.id === latestMatch.hero_id) ?? null;
				const heroName = hero ? hero.name : 'Unknown Hero';
				const heroDisplayName = formatHeroName(heroName);
				const heroIconUrl = hero ? buildHeroAssetUrl(heroName) : undefined;
				const opendotaMatchUrl = `https://www.opendota.com/matches/${latestMatch.match_id}`;
				const isRadiant = latestMatch.player_slot < 128;
				const isWin =
					(isRadiant && latestMatch.radiant_win) || (!isRadiant && !latestMatch.radiant_win);
				const resultText = isWin ? '🏆 Won' : '❌ Lost';

				return json({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: {
						embeds: [
							{
								title: `Latest Match Result - Match ${latestMatch.match_id}`,
								color: isWin ? 0x2ecc71 : 0xe74c3c,
								thumbnail: heroIconUrl ? { url: heroIconUrl } : undefined,
								description: `Hero: ${heroDisplayName}${heroIconUrl ? ' 🏹' : ''}\n[OpenDota Match](${opendotaMatchUrl})`,
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
					}
				});
			} catch (error) {
				console.error('OpenDota fetch failure:', error.response?.data || error.message);
				return json({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: { content: 'Failed to fetch match data from OpenDota.' }
				});
			}
		}
	}

	return json({ error: 'Unknown interaction command variant' }, { status: 400 });
}

