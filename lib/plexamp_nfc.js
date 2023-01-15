import nfcCard from 'nfccard-tool';
import {
	getPlayerUri,
	start_player,
	pause_player,
	resume_player,
} from './process_plexamp_command.js';
import fs from 'fs';
import EventSource from 'eventsource';

let pauseOnCardRemoval = false,
	resumeOnCardPlacement = true,
	trackCardState = false;

let uri, cardUri;

let eventSource, playState, cardState;

const plexamp_nfc = (nfc) => {
	console.log(
		'Control your Plexamp players with NFC cards. Searching for PCSC-compatible NFC reader...'
	);

	nfc.on('reader', (reader) => {
		console.log(`${reader.reader.name} device attached`);

		reader.on('card', async (card) => {
			console.log(`${reader.reader.name} detected ${card.type} with UID ${card.uid}`);

			try {
				/**
				 * 1 - READ HEADER
				 *  Read from block 0 to block 4 (20 bytes length) in order to parse tag information
				 *  Block 4 is the first data block -- should have the TLV info
				 */
				const cardHeader = await reader.read(0, 20);

				nfcCard.parseInfo(cardHeader);

				/**
				 *  2 - Read the NDEF message and parse it if it's supposed there is one
				 *  The NDEF message must begin in block 4 -- no locked bits, etc.
				 *  Make sure cards are initialized before writing.
				 */
				if (
					nfcCard.isFormatedAsNDEF() &&
					nfcCard.hasReadPermissions() &&
					nfcCard.hasNDEFMessage()
				) {
					// Read the appropriate length to get the NDEF message as buffer
					const NDEFRawMessage = await reader.read(4, nfcCard.getNDEFMessageLengthToRead()); // starts reading in block 0 until end

					// Parse the buffer as a NDEF raw message
					const NDEFMessage = nfcCard.parseNDEF(NDEFRawMessage);

					cardUri = new URL(NDEFMessage[0].uri);

					if (!cardUri.pathname.startsWith('/player')) {
						throw new Error(`Unexpected URL: ${cardUri.href}`);
					}

					({ trackCardState } = JSON.parse(fs.readFileSync('settings.json', 'utf-8')));

					if (trackCardState) {
						eventSource = new EventSource(`${getPlayerUri()}/:/eventsource/notifications`);
						eventSource.addEventListener('state', setPlayState, false);
					}

					({ resumeOnCardPlacement } = JSON.parse(fs.readFileSync('settings.json', 'utf-8')));

					if (isActiveCard() && resumeOnCardPlacement) {
						await resume_player();
					} else {
						uri = cardUri;
						await start_player(uri);
						cardState = null;
					}

					if (trackCardState) {
						eventSource.addEventListener('state', setCardState, false);
					}
				} else {
					console.log(
						'Could not parse anything from this tag: \n The tag is either empty, locked, has a wrong NDEF format or is unreadable.'
					);
				}
			} catch (err) {
				console.error(err.toString());
			}
		});
		reader.on('card.off', async (card) => {
			console.log(`${reader.reader.name}: ${card.type} with UID ${card.uid} removed`);
			try {
				({ pauseOnCardRemoval } = JSON.parse(fs.readFileSync('settings.json', 'utf-8')));

				if (cardUri && isActiveCard() && pauseOnCardRemoval) {
					await pause_player();
				}
			} catch (err) {
				console.error(err.toString());
			}
			cardUri = null;
			if (eventSource) {
				eventSource.close();
			}
		});
		reader.on('error', (err) => {
			console.error(`${reader.reader.name} an error occurred`, err);
		});
		reader.on('end', () => {
			console.log(`${reader.reader.name} device removed`);
		});
	});
	nfc.on('error', (err) => {
		console.log('an NFC error occurred', err);
	});
};

const setPlayState = (e) => {
	if (!playState) {
		playState = {
			state: undefined,
			parentKey: undefined,
			grandparentKey: undefined,
		};
	}
	const data = JSON.parse(e.data);
	playState.state = data.state;
	switch (data.state) {
		case 'playing':
			switch (cardState?.type) {
				case 'album':
					if (
						data.parentKey &&
						data.parentKey !== playState.parentKey &&
						data.parentKey !== cardState.parentKey
					) {
						console.log(
							`Album changed. Now playing ${data.grandparentTitle} - ${data.parentTitle}`
						);
					}
					break;
				case 'artist':
					if (
						data.grandparentKey &&
						data.grandparentKey !== playState.grandparentKey &&
						data.grandparentKey !== cardState.grandparentKey
					) {
						console.log(`Artist changed. Now playing ${data.grandparentTitle}`);
					}
					break;
			}
		case 'playing':
		case 'stopped':
			playState.parentKey = data.parentKey;
			playState.grandparentKey = data.grandparentKey;
			break;
	}
};

const setCardState = (e) => {
	if (!cardState) {
		cardState = {
			type: undefined,
			parentKey: undefined,
			grandparentKey: undefined,
		};
	}
	const data = JSON.parse(e.data);
	switch (data.state) {
		case 'playing':
			if (data.parentKey && data.grandparentKey) {
				eventSource.removeEventListener('state', setCardState, false);
				const decoded = decodeURIComponent(uri?.search);
				cardState.type = decoded.includes(`${data.parentKey}/`)
					? 'album'
					: decoded.includes(`${data.grandparentKey}/`)
					? 'artist'
					: null;
				switch (cardState.type) {
					case 'album':
						if (data.parentKey !== cardState.parentKey) {
							cardState.parentKey = data.parentKey;
							console.log(`Album tag placed: ${data.grandparentTitle} - ${data.parentTitle}`);
						}
						break;
					case 'artist':
						if (data.grandparentKey !== cardState.grandparentKey) {
							cardState.grandparentKey = data.grandparentKey;
							console.log(`Artist tag placed: ${data.grandparentTitle}`);
						}
						break;
					default:
						eventSource.close();
				}
			}
			break;
	}
};

const isActiveCard = () => {
	switch (cardState?.type) {
		case 'album':
			return cardUri?.href === uri?.href && cardState?.parentKey === playState?.parentKey;
		case 'artist':
			return cardUri?.href === uri?.href && cardState?.grandparentKey === playState?.grandparentKey;
	}
	return cardUri?.href === uri?.href;
};

export default plexamp_nfc;
