import { json } from '@sveltejs/kit';
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';
import { DISCORD_PUBLIC_KEY } from '\$env/static/private';
import axios from 'axios';
import { Buffer } from 'node:buffer'; // FIX: Ensure Buffer is available to prevent verifyKey from crashing

export async function POST({ request, platform }) {
    // 1. Verify the request is actually coming from Discord
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');
    const rawBody = await request.text();

    // Ensure we don't crash if headers are missing
    if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
        return new Response('Missing signature headers or configuration', { status: 401 });
    }

    const isValidRequest = verifyKey(
        Buffer.from(rawBody), 
        signature, 
        timestamp, 
        DISCORD_PUBLIC_KEY
    );
    
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
        // FIX: Safely parse via optional chaining because data elements are not guaranteed
        const name = interaction.data?.name;
        const options = interaction.data?.options;
        const token = interaction.token;
        const application_id = interaction.application_id;

        if (name === 'match') {
            // Find the accountId element option safely
            const accountIdOption = options?.find(opt => opt.name === 'account_id' || opt.type === 3 || opt.type === 4);
            const accountId = accountIdOption ? accountIdOption.value : options?.[0]?.value;

            if (!accountId) {
                return json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: 'Please provide a valid account ID.' }
                });
            }

            // Tell Vercel to keep the lambda alive until the background fetch finishes
            if (platform && typeof platform.waitUntil === 'function') {
                platform.waitUntil(fetchAndSendMatchData(accountId, token, application_id));
            } else {
                fetchAndSendMatchData(accountId, token, application_id);
            }

            // Acknowledge within the 3-second window
            return json({
                type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
            });
        }
    }

    return json({ error: 'Unknown interaction' }, { status: 400 });
}

// Helper function to process data and patch the message via webhook channel
async function fetchAndSendMatchData(accountId, token, applicationId) {
    const followUpUrl = `https://discord.com{applicationId}/${token}`;

    try {
        const response = await axios.get(`https://opendota.com{accountId}/recentMatches`);
        const recentMatches = response.data;
        const latestMatch = Array.isArray(recentMatches) ? recentMatches[0] : null;

        if (!latestMatch) {
            await axios.post(followUpUrl, {
                content: `No recent matches found for account ID: ${accountId}`
            });
            return;
        }

        const isRadiant = latestMatch.player_slot < 128;
        const isWin = (isRadiant && latestMatch.radiant_win) || (!isRadiant && !latestMatch.radiant_win);
        const resultText = isWin ? "🏆 Won" : "❌ Lost";

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
            console.error("Failed to send webhook error fallback:", webhookError.response?.data || webhookError.message);
        }
    }
}
