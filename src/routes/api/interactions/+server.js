import { json } from '@sveltejs/kit';
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import { DISCORD_PUBLIC_KEY } from '\$env/static/private';
import axios from 'axios';

export async function POST({ request }) {
    // 1. Verify the request is actually coming from Discord
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const rawBody = await request.text();

    const isValidRequest = verifyKey(rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
    if (!isValidRequest) {
        return new Response('Invalid request signature', { status: 401 });
    }

    const interaction = JSON.parse(rawBody);

    // 2. Handle Discord's initial URL validation ping
    if (interaction.type === InteractionType.PING) {
        return json({ type: InteractionResponseType.PONG });
    }

    // 3. Handle Slash Commands
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name, options, token } = interaction; // Destructure the interaction token

        if (name === 'match') {
            const accountId = options[0].value;

            // Bypasses the 3-second limit. Shows "Bot is thinking..." in Discord
            // Run the API call asynchronously out-of-band
            fetchAndSendMatchData(accountId, token, interaction.application_id);

            return json({
                type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
            });
        }
    }

    return json({ error: 'Unknown interaction' }, { status: 400 });
}

// Separate helper function to handle the API work and follow up with Discord
async function fetchAndSendMatchData(accountId, token, applicationId) {
    const followUpUrl = `https://discord.com{applicationId}/${token}`;

    try {
        // Corrected OpenDota URL and variable interpolation
        const response = await axios.get(`https://opendota.com/${accountId}/recentMatches`);
        const latestMatch = response.data[0];

        if (!latestMatch) {
            await axios.post(followUpUrl, {
                content: `No recent matches found for account ID: ${accountId}`
            });
            return;
        }

        // Determine match result
        const isRadiant = latestMatch.player_slot < 128;
        const isWin = (isRadiant && latestMatch.radiant_win) || (!isRadiant && !latestMatch.radiant_win);
        const resultText = isWin ? "🏆 Won" : "❌ Lost";

        // Update the deferred message via Discord Webhook callback
        await axios.post(followUpUrl, {
            embeds: [{
                title: `Latest Match Result - Match ${latestMatch.match_id}`,
                color: isWin ? 0x2ecc71 : 0xe74c3c,
                fields: [
                    { name: 'Result', value: resultText, inline: true },
                    { name: 'K/D/A', value: `${latestMatch.kills}/${latestMatch.deaths}/${latestMatch.assists}`, inline: true },
                    { name: 'Duration', value: `${Math.floor(latestMatch.duration / 60)}m`, inline: true }
                ]
            }]
        });

    } catch (error) {
        console.error(error);
        await axios.post(followUpUrl, {
            content: 'Failed to fetch match data from OpenDota.'
        });
    }
}