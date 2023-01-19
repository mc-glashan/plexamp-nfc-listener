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
						eventSource.on('error', (err) => {
							console.error(`an EventSource error occurred`, err);
						});
						eventSource.addEventListener('state', initPlayState, false);
						try {
							await untilPlayState();
							console.log(`Play state init complete`);
						} catch {
							console.log(`Play state init timed out`);
						}
					}

					({ resumeOnCardPlacement } = JSON.parse(fs.readFileSync('settings.json', 'utf-8')));

					if (isActiveCard() && resumeOnCardPlacement) {
						await resume_player();
						if (trackCardState) {
							switch (cardState?.type) {
								case 'album':
								case 'artist':
									eventSource.addEventListener('state', trackPlayState, false);
									break;
							}
						}
					} else {
						uri = cardUri;
						await start_player(uri);
						if (trackCardState) {
							eventSource.addEventListener('state', initCardState, false);
						}
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
			if (eventSource && eventSource.readyState === 1) {
				console.log(`Closing eventsource`);
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

const initPlayState = (e) => {
	eventSource.removeEventListener('state', initPlayState, false);
	const data = JSON.parse(e.data);
	playState = {
		state: data.state,
		parentKey: data.parentKey,
		grandparentKey: data.grandparentKey,
	};
};

const untilPlayState = async () => {
	return new Promise((resolve, reject) => {
		const timeout = 1000;
		const start = new Date();
		const wait = setInterval(function () {
			if (playState) {
				clearInterval(wait);
				resolve();
			} else if (new Date() - start > timeout) {
				clearInterval(wait);
				reject();
			}
		}, 25);
	});
};

const initCardState = (e) => {
	const data = JSON.parse(e.data);
	switch (data.state) {
		case 'playing':
			if (data.parentKey && data.grandparentKey) {
				cardState = {
					type: undefined,
					parentKey: undefined,
					grandparentKey: undefined,
				};
				eventSource.removeEventListener('state', initCardState, false);
				const decoded = decodeURIComponent(uri?.search);
				cardState.type = decoded.includes(`${data.parentKey}/`)
					? 'album'
					: decoded.includes(`${data.grandparentKey}/`)
					? 'artist'
					: null;
				switch (cardState.type) {
					case 'album':
						cardState.parentKey = data.parentKey;
						console.log(`Album tag in place: ${data.grandparentTitle} - ${data.parentTitle}`);
						eventSource.addEventListener('state', trackPlayState, false);
						break;
					case 'artist':
						cardState.grandparentKey = data.grandparentKey;
						console.log(`Artist tag in place: ${data.grandparentTitle}`);
						eventSource.addEventListener('state', trackPlayState, false);
						break;
					default:
						console.log(`Closing eventsource`);
						eventSource.close();
				}
			}
			break;
	}
};

const trackPlayState = (e) => {
	const data = JSON.parse(e.data);
	playState = {
		state: data.state,
		parentKey: data.parentKey,
		grandparentKey: data.grandparentKey,
	};
	switch (playState.state) {
		case 'playing':
			switch (cardState?.type) {
				case 'album':
					if (playState.parentKey && playState.parentKey !== cardState.parentKey) {
						console.log(`Album changed: ${data.grandparentTitle} - ${data.parentTitle}`);
						console.log(`Closing eventsource`);
						eventSource.close();
					}
					break;
				case 'artist':
					if (playState.grandparentKey && playState.grandparentKey !== cardState.grandparentKey) {
						console.log(`Artist changed: ${data.grandparentTitle}`);
						console.log(`Closing eventsource`);
						eventSource.close();
					}
					break;
			}
			break;
		case 'stopped':
			console.log(`Closing eventsource`);
			eventSource.close();
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
