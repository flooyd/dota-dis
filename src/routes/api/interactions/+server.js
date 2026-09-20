import { json } from '@sveltejs/kit';
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import { DISCORD_PUBLIC_KEY } from '\$env/static/private';
import axios from 'axios';

// Add { platform } to access Vercel's lifecycle hooks
export async function POST({ request, platform }) {
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
        // FIXED: name and options are in data. token and application_id are on root.
        const { name, options } = interaction.data; 
        const { token, application_id } = interaction; 

        if (name === 'match') {
            const accountId = options[0].value;

            // FIXED: Prevent Vercel from freezing/killing the background task.
            // This holds the lambda function open until the promise resolves.
            if (platform && typeof platform.waitUntil === 'function') {
                platform.waitUntil(fetchAndSendMatchData(accountId, token, application_id));
            } else {
                // Fallback for local development environment if platform is undefined
                fetchAndSendMatchData(accountId, token, application_id);
            }

            // Acknowledge within 3 seconds so Discord doesn't timeout
            return json({
                type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
            });
        }
    }

    return json({ error: 'Unknown interaction' }, { status: 400 });
}

// Separate helper function to handle the API work and follow up with Discord
async function fetchAndSendMatchData(accountId, token, applicationId) {
    const followUpUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;

    try {
        // FIXED: Using correct OpenDota API endpoint structure
        const response = await axios.get(`https://opendota.com{accountId}/recentMatches`);
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
        console.error("Background Error:", error.response?.data || error.message);
        try {
            await axios.post(followUpUrl, {
                content: 'Failed to fetch match data from OpenDota.'
            });
        } catch (webhookError) {
            console.error("Failed to send webhook error:", webhookError.response?.data || webhookError.message);
        }
    }
}