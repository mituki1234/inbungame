const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 静的ファイルの提供
app.use(express.static(path.join(__dirname)));

// ゲーム管理用のデータ構造
const players = new Map(); // playerId -> playerData
const waitingPlayers = new Map(); // difficulty -> [playerIds]
const activeGames = new Map(); // gameId -> gameState
const customRooms = new Map(); // roomCode -> {host, guest, difficulty}

// 素数配列
const normalPrimes = [2, 3, 5, 7, 11, 13, 17, 19];
const hardPrimes = [7, 11, 13, 17, 19, 23, 29, 31];
const fieldCardUpperLimit = 5;

// 代名詞リスト
const pronouns = ['あなた', 'わたし', 'きみ', 'やつ', 'おまえ', 'じぶん', 'われ', 'おれ'];

// レート計算関数
function calculateRatingChange(winnerRating, loserRating, isWinner) {
    const K_BASE = 32;
    const MAX_RATING = 6000;
    const MIN_RATING = 1000;
    
    // レートが高いほどK値を小さくする（上がりにくくする）
    const kFactor = K_BASE * Math.max(0.1, 1 - (winnerRating / MAX_RATING) ** 2);
    
    // 期待勝率計算
    const expectedScore = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    
    // レート変動計算
    let ratingChange = Math.round(kFactor * (1 - expectedScore));
    
    // 6000に近づくほど上がりにくく、負けた時は大きく下がる
    if (isWinner) {
        if (winnerRating >= 5500) {
            ratingChange = Math.max(1, Math.round(ratingChange * 0.3));
        } else if (winnerRating >= 5000) {
            ratingChange = Math.round(ratingChange * 0.6);
        }
    } else {
        // 負けた時は通常のレート変動
        ratingChange = Math.round(kFactor * expectedScore);
        if (winnerRating >= 4000) {
            ratingChange = Math.round(ratingChange * 1.5); // 高レートは負けた時により大きく下がる
        }
    }
    
    return Math.min(100, Math.max(1, ratingChange)); // 最小1、最大100の変動
}

// ルームコード生成
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ゲーム状態クラス
class GameState {
    constructor(player1, player2, difficulty, gameId, isCustom = false) {
        this.gameId = gameId;
        this.player1 = player1;
        this.player2 = player2;
        this.difficulty = difficulty;
        this.isCustom = isCustom;
        this.primes = difficulty === 'hard' ? hardPrimes : normalPrimes;
        
        // 山札を30枚ずつ作成
        this.player1Deck = this.generateDeck();
        this.player2Deck = this.generateDeck();
        
        // 初期手札（5枚ずつ）
        this.player1Cards = this.player1Deck.splice(0, fieldCardUpperLimit);
        this.player2Cards = this.player2Deck.splice(0, fieldCardUpperLimit);
        
        // ターゲット値
        this.targetValue = this.generateBalancedTarget();
        
        this.status = 'countdown'; // カウントダウン状態から開始
        this.winner = null;
        this.lastUpdate = Date.now();
        
        // 生存確認用
        this.player1Alive = Date.now();
        this.player2Alive = Date.now();
        
        // 強制チェック用
        this.forceCheckInterval = null;
        
        // カウントダウン開始
        this.startCountdown();
    }

    startCountdown() {
        let count = 3;
        const countdownInterval = setInterval(() => {
            if (count > 0) {
                // カウントダウンを両プレイヤーに送信
                io.to(this.player1.id).emit('countdown', { count });
                io.to(this.player2.id).emit('countdown', { count });
                count--;
            } else {
                // START!
                io.to(this.player1.id).emit('countdown', { count: 'START!' });
                io.to(this.player2.id).emit('countdown', { count: 'START!' });
                
                // ゲーム開始
                setTimeout(() => {
                    this.status = 'playing';
                    this.startForceCheck();
                    
                    // ゲーム状態を両プレイヤーに送信
                    io.to(this.player1.id).emit('gameUpdate', this.getGameStateForPlayer(this.player1.id));
                    io.to(this.player2.id).emit('gameUpdate', this.getGameStateForPlayer(this.player2.id));
                }, 1000);
                
                clearInterval(countdownInterval);
            }
        }, 1000);
    }

    generateDeck() {
        const deck = [];
        for (let i = 0; i < 30; i++) {
            deck.push(this.primes[Math.floor(Math.random() * this.primes.length)]);
        }
        return deck;
    }

    generateBalancedTarget() {
        let value = 1;
        const complexity = this.difficulty === 'hard' ? 
            6 + Math.floor(Math.random() * 3) : 
            5 + Math.floor(Math.random() * 3);
        
        for (let i = 0; i < complexity; i++) {
            value *= this.primes[Math.floor(Math.random() * this.primes.length)];
        }
        
        return value;
    }

    generateNewTarget() {
        this.targetValue = this.generateBalancedTarget();
        this.lastUpdate = Date.now();
        return this.targetValue;
    }

    refillCard(isPlayer1) {
        if (isPlayer1) {
            if (this.player1Deck.length > 0 && this.player1Cards.length < fieldCardUpperLimit) {
                this.player1Cards.push(this.player1Deck.pop());
                return true;
            }
        } else {
            if (this.player2Deck.length > 0 && this.player2Cards.length < fieldCardUpperLimit) {
                this.player2Cards.push(this.player2Deck.pop());
                return true;
            }
        }
        return false;
    }

    checkWinCondition() {
        if (this.player1Deck.length === 0 && this.player1Cards.length === 0) {
            return this.player1.id;
        }
        if (this.player2Deck.length === 0 && this.player2Cards.length === 0) {
            return this.player2.id;
        }
        return null;
    }

    checkCanDivision() {
        for (let card of this.player1Cards) {
            if (this.targetValue % card === 0) {
                return false;
            }
        }
        
        for (let card of this.player2Cards) {
            if (this.targetValue % card === 0) {
                return false;
            }
        }
        
        return true;
    }

    compulsionDivision() {
        for (let prime of this.primes) {
            if (this.targetValue % prime === 0) {
                this.targetValue /= prime;
                console.log(`強制除算: ${prime}で割りました`);
                return true;
            }
        }
        
        this.generateNewTarget();
        console.log('新しいターゲットを生成しました');
        return false;
    }

    startForceCheck() {
        if (this.forceCheckInterval) {
            clearInterval(this.forceCheckInterval);
        }
        
        this.forceCheckInterval = setInterval(() => {
            if (this.status === 'playing' && this.checkCanDivision()) {
                console.log('強制割り算を実行');
                this.compulsionDivision();
                
                io.to(this.player1.id).emit('gameUpdate', this.getGameStateForPlayer(this.player1.id));
                io.to(this.player2.id).emit('gameUpdate', this.getGameStateForPlayer(this.player2.id));
            }
        }, 1000);
    }

    getGameStateForPlayer(playerId) {
        const isPlayer1 = playerId === this.player1.id;
        
        return {
            gameId: this.gameId,
            targetValue: this.targetValue,
            myCards: isPlayer1 ? this.player1Cards : this.player2Cards,
            myDeckCount: isPlayer1 ? this.player1Deck.length : this.player2Deck.length,
            opponentCards: isPlayer1 ? this.player2Cards.length : this.player1Cards.length,
            opponentDeckCount: isPlayer1 ? this.player2Deck.length : this.player1Deck.length,
            opponentName: isPlayer1 ? this.player2.displayName : this.player1.displayName,
            difficulty: this.difficulty,
            status: this.status,
            lastUpdate: this.lastUpdate
        };
    }

    cleanup() {
        if (this.forceCheckInterval) {
            clearInterval(this.forceCheckInterval);
            this.forceCheckInterval = null;
        }
    }
}

// Socket.IO接続処理
io.on('connection', (socket) => {
    console.log('プレイヤー接続:', socket.id);

    // プレイヤー登録
    socket.on('joinGame', (playerData) => {
        const pronoun = pronouns[Math.floor(Math.random() * pronouns.length)];
        const player = {
            id: socket.id,
            name: playerData.name || `プレイヤー${socket.id.substring(0, 6)}`,
            pronoun: pronoun,
            rating: 3000, // 初期レート3000
            displayName: `${pronoun}(3000)`
        };
        
        players.set(socket.id, player);
        
        socket.emit('playerRegistered', {
            id: socket.id,
            name: player.name,
            pronoun: player.pronoun,
            rating: player.rating,
            displayName: player.displayName,
            message: '登録完了'
        });
        
        console.log('プレイヤー登録:', player.displayName);
    });

    // ランダムマッチング開始
    socket.on('startMatching', (data) => {
        const difficulty = data.difficulty || 'normal';
        const player = players.get(socket.id);
        
        if (!player) {
            socket.emit('error', { message: 'プレイヤーが登録されていません' });
            return;
        }

        if (!waitingPlayers.has(difficulty)) {
            waitingPlayers.set(difficulty, []);
        }
        
        const waitingList = waitingPlayers.get(difficulty);
        
        if (!waitingList.includes(socket.id)) {
            waitingList.push(socket.id);
            
            socket.emit('matchingStarted', {
                message: '対戦相手を探しています...'
            });
            
            console.log(`${player.displayName} がマッチング開始 (${difficulty})`);
            
            tryMatchmaking(difficulty);
        }
    });

    // カスタムマッチ作成
    socket.on('createCustomRoom', (data) => {
        const difficulty = data.difficulty || 'normal';
        const player = players.get(socket.id);
        
        if (!player) {
            socket.emit('error', { message: 'プレイヤーが登録されていません' });
            return;
        }

        const roomCode = generateRoomCode();
        customRooms.set(roomCode, {
            host: player,
            guest: null,
            difficulty: difficulty,
            created: Date.now()
        });

        socket.emit('customRoomCreated', {
            roomCode: roomCode,
            difficulty: difficulty
        });

        console.log(`カスタムルーム作成: ${roomCode} by ${player.displayName}`);
    });

    // カスタムルーム参加
    socket.on('joinCustomRoom', (data) => {
        const { roomCode } = data;
        const player = players.get(socket.id);
        
        if (!player) {
            socket.emit('error', { message: 'プレイヤーが登録されていません' });
            return;
        }

        const room = customRooms.get(roomCode);
        if (!room) {
            socket.emit('error', { message: 'ルームが見つかりません' });
            return;
        }

        if (room.guest) {
            socket.emit('error', { message: 'ルームが満員です' });
            return;
        }

        if (room.host.id === socket.id) {
            socket.emit('error', { message: '自分のルームには参加できません' });
            return;
        }

        room.guest = player;
        
        // カスタムゲーム開始
        createGame(room.host, room.guest, room.difficulty, true);
        customRooms.delete(roomCode);

        console.log(`カスタムルーム参加: ${roomCode} by ${player.displayName}`);
    });

    // マッチングキャンセル
    socket.on('cancelMatching', (data) => {
        const difficulty = data.difficulty || 'normal';
        removeFromWaiting(socket.id, difficulty);
        
        socket.emit('matchingCancelled', {
            message: 'マッチングをキャンセルしました'
        });
    });

    // カードプレイ
    socket.on('playCard', (data) => {
        const { gameId, cardIndex } = data;
        const game = activeGames.get(gameId);
        
        if (!game || game.status !== 'playing') {
            return;
        }

        const isPlayer1 = socket.id === game.player1.id;
        const playerCards = isPlayer1 ? game.player1Cards : game.player2Cards;
        
        if (cardIndex >= playerCards.length) {
            return;
        }

        const cardValue = playerCards[cardIndex];
        
        if (game.targetValue % cardValue !== 0) {
            socket.emit('invalidMove', {
                message: 'そのカードは使用できません',
                penalty: true
            });
            return;
        }

        game.targetValue /= cardValue;
        playerCards.splice(cardIndex, 1);
        
        game.refillCard(isPlayer1);
        
        if (game.targetValue === 1) {
            game.generateNewTarget();
        }

        const winner = game.checkWinCondition();
        if (winner) {
            game.status = 'finished';
            game.winner = winner;
            endGame(gameId);
        } else {
            game.lastUpdate = Date.now();
            
            if (isPlayer1) {
                game.player1Alive = Date.now();
            } else {
                game.player2Alive = Date.now();
            }

            io.to(game.player1.id).emit('gameUpdate', game.getGameStateForPlayer(game.player1.id));
            io.to(game.player2.id).emit('gameUpdate', game.getGameStateForPlayer(game.player2.id));
        }

        console.log(`${isPlayer1 ? game.player1.displayName : game.player2.displayName} がカードを使用: ${cardValue}`);
    });

    // 生存確認
    socket.on('heartbeat', (data) => {
        const { gameId } = data;
        const game = activeGames.get(gameId);
        
        if (game && game.status === 'playing') {
            const isPlayer1 = socket.id === game.player1.id;
            const now = Date.now();
            
            if (isPlayer1) {
                game.player1Alive = now;
            } else {
                game.player2Alive = now;
            }
        }
    });

    // 切断処理
    socket.on('disconnect', () => {
        console.log('プレイヤー切断:', socket.id);
        
        for (const [difficulty, waitingList] of waitingPlayers.entries()) {
            removeFromWaiting(socket.id, difficulty);
        }
        
        // カスタムルーム削除
        for (const [roomCode, room] of customRooms.entries()) {
            if (room.host.id === socket.id) {
                customRooms.delete(roomCode);
            }
        }
        
        for (const [gameId, game] of activeGames.entries()) {
            if (game.player1.id === socket.id || game.player2.id === socket.id) {
                const opponent = game.player1.id === socket.id ? game.player2 : game.player1;
                
                if (game.status === 'playing' || game.status === 'countdown') {
                    game.status = 'finished';
                    game.winner = opponent.id;
                    
                    io.to(opponent.id).emit('opponentDisconnected', {
                        message: '相手が切断しました。あなたの勝利です！'
                    });
                    
                    endGame(gameId);
                }
                break;
            }
        }
        
        players.delete(socket.id);
    });
});

// マッチング処理（レート考慮）
function tryMatchmaking(difficulty) {
    const waitingList = waitingPlayers.get(difficulty);
    
    if (waitingList && waitingList.length >= 2) {
        // レート差300以内でマッチング
        for (let i = 0; i < waitingList.length - 1; i++) {
            for (let j = i + 1; j < waitingList.length; j++) {
                const player1 = players.get(waitingList[i]);
                const player2 = players.get(waitingList[j]);
                
                if (player1 && player2) {
                    const ratingDiff = Math.abs(player1.rating - player2.rating);
                    if (ratingDiff <= 300) {
                        // マッチング成功
                        waitingList.splice(j, 1); // j > i なので先に削除
                        waitingList.splice(i, 1);
                        
                        createGame(player1, player2, difficulty, false);
                        return;
                    }
                }
            }
        }
        
        // レート差300以内が見つからない場合、待ち時間が長い人同士をマッチング
        if (waitingList.length >= 2) {
            const player1Id = waitingList.shift();
            const player2Id = waitingList.shift();
            
            const player1 = players.get(player1Id);
            const player2 = players.get(player2Id);
            
            if (player1 && player2) {
                createGame(player1, player2, difficulty, false);
            }
        }
    }
}

// ゲーム作成
function createGame(player1, player2, difficulty, isCustom) {
    const gameId = `game_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const game = new GameState(player1, player2, difficulty, gameId, isCustom);
    
    activeGames.set(gameId, game);
    
    io.to(player1.id).emit('gameStart', {
        gameId: gameId,
        opponent: player2.displayName,
        difficulty: difficulty,
        isCustom: isCustom,
        gameState: game.getGameStateForPlayer(player1.id)
    });
    
    io.to(player2.id).emit('gameStart', {
        gameId: gameId,
        opponent: player1.displayName,
        difficulty: difficulty,
        isCustom: isCustom,
        gameState: game.getGameStateForPlayer(player2.id)
    });
    
    console.log(`ゲーム作成: ${player1.displayName} vs ${player2.displayName} (${difficulty}) ${isCustom ? '[Custom]' : '[Ranked]'}`);
}

// ゲーム終了
function endGame(gameId) {
    const game = activeGames.get(gameId);
    
    if (!game) return;
    
    const player1 = players.get(game.player1.id);
    const player2 = players.get(game.player2.id);
    
    if (!player1 || !player2) {
        game.cleanup();
        activeGames.delete(gameId);
        return;
    }

    const isPlayer1Winner = game.winner === game.player1.id;
    const isPlayer2Winner = game.winner === game.player2.id;
    
    let ratingChanges = { player1: 0, player2: 0 };
    
    // ランクマッチの場合のみレート変動
    if (!game.isCustom && (isPlayer1Winner || isPlayer2Winner)) {
        if (isPlayer1Winner) {
            ratingChanges.player1 = calculateRatingChange(player1.rating, player2.rating, true);
            ratingChanges.player2 = -calculateRatingChange(player2.rating, player1.rating, false);
        } else {
            ratingChanges.player2 = calculateRatingChange(player2.rating, player1.rating, true);
            ratingChanges.player1 = -calculateRatingChange(player1.rating, player2.rating, false);
        }
        
        // レート更新
        player1.rating = Math.max(1000, Math.min(6000, player1.rating + ratingChanges.player1));
        player2.rating = Math.max(1000, Math.min(6000, player2.rating + ratingChanges.player2));
        
        // 表示名更新
        player1.displayName = `${player1.pronoun}(${player1.rating})`;
        player2.displayName = `${player2.pronoun}(${player2.rating})`;
        
        players.set(player1.id, player1);
        players.set(player2.id, player2);
    }
    
    // 結果送信
    io.to(game.player1.id).emit('gameEnd', {
        winner: game.winner,
        isWinner: isPlayer1Winner,
        opponentName: player2.displayName,
        ratingChange: ratingChanges.player1,
        newRating: player1.rating,
        isCustom: game.isCustom
    });
    
    io.to(game.player2.id).emit('gameEnd', {
        winner: game.winner,
        isWinner: isPlayer2Winner,
        opponentName: player1.displayName,
        ratingChange: ratingChanges.player2,
        newRating: player2.rating,
        isCustom: game.isCustom
    });
    
    console.log(`ゲーム終了: ${game.gameId}, 勝者: ${game.winner || '引き分け'}, レート変動: P1(${ratingChanges.player1}) P2(${ratingChanges.player2})`);
    
    game.cleanup();
    activeGames.delete(gameId);
}

// 待機リストから削除
function removeFromWaiting(playerId, difficulty) {
    const waitingList = waitingPlayers.get(difficulty);
    if (waitingList) {
        const index = waitingList.indexOf(playerId);
        if (index > -1) {
            waitingList.splice(index, 1);
        }
    }
}

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
});