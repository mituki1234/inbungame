const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// JSON解析用
app.use(express.json());

// 静的ファイルの提供
app.use(express.static(path.join(__dirname)));

// データベース初期化
const db = new sqlite3.Database('./game.db');

// テーブル作成
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT,
        pronoun TEXT,
        rating INTEGER DEFAULT 3000,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        is_guest INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ゲーム管理用のデータ構造
const players = new Map(); // playerId -> playerData
const waitingPlayers = []; // playerIdの配列
const activeGames = new Map(); // gameId -> gameState
const customRooms = new Map(); // roomCode -> {host, guest}

// 素数配列
const primes = [2, 3, 5, 7, 11, 13];
const fieldCardUpperLimit = 5;

// 各素数の最大出現回数
const maxPrimeCount = {
    2: 6,
    3: 5,
    5: 4,
    7: 4,
    11: 3,
    13: 3
};

// 代名詞リスト
const pronouns = ['あなた', 'わたし', 'きみ', 'やつ', 'おまえ', 'じぶん', 'われ', 'おれ'];

// ユーザー認証関数
async function authenticateUser(username, password, isGuest = false) {
    return new Promise((resolve, reject) => {
        if (isGuest) {
            // ゲストユーザーの場合
            const tempId = Date.now() + Math.random();
            const pronoun = pronouns[Math.floor(Math.random() * pronouns.length)];
            
            const guestUser = {
                id: tempId,
                username: `ゲスト${tempId.toString().slice(-6)}`,
                pronoun: pronoun,
                rating: 3000,
                wins: 0,
                losses: 0,
                is_guest: true,
                displayName: `${pronoun}(3000)`
            };
            
            resolve(guestUser);
        } else {
            // 登録ユーザーの場合
            db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (user) {
                    // 既存ユーザー
                    if (user.password && password) {
                        // パスワードが設定されている場合
                        const isValid = await bcrypt.compare(password, user.password);
                        if (isValid) {
                            // ログイン時間更新
                            db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
                            
                            user.displayName = `${user.pronoun}(${user.rating})`;
                            resolve(user);
                        } else {
                            reject(new Error('パスワードが間違っています'));
                        }
                    } else if (!user.password && !password) {
                        // パスワードなしユーザー
                        db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
                        
                        user.displayName = `${user.pronoun}(${user.rating})`;
                        resolve(user);
                    } else {
                        reject(new Error('認証情報が正しくありません'));
                    }
                } else {
                    // 新規ユーザー
                    const pronoun = pronouns[Math.floor(Math.random() * pronouns.length)];
                    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
                    
                    db.run(`INSERT INTO users (username, password, pronoun, is_guest) VALUES (?, ?, ?, ?)`, 
                        [username, hashedPassword, pronoun, 0], 
                        function(err) {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            const newUser = {
                                id: this.lastID,
                                username: username,
                                pronoun: pronoun,
                                rating: 3000,
                                wins: 0,
                                losses: 0,
                                is_guest: false,
                                displayName: `${pronoun}(3000)`
                            };
                            
                            resolve(newUser);
                        }
                    );
                }
            });
        }
    });
}

// レート更新関数
function updateUserRating(userId, newRating, isWinner) {
    if (typeof userId === 'string' && userId.includes('temp')) {
        // ゲストユーザーの場合は更新しない
        return;
    }
    
    const winColumn = isWinner ? 'wins = wins + 1' : 'losses = losses + 1';
    db.run(`UPDATE users SET rating = ?, ${winColumn} WHERE id = ?`, [newRating, userId]);
}

// レート計算関数
function calculateRatingChange(playerRating, opponentRating, isWinner) {
    const K_BASE = 32;
    const MAX_RATING = 6000;
    
    // レートが高いほどK値を小さくする（上がりにくくする）
    const kFactor = K_BASE * Math.max(0.1, 1 - (playerRating / MAX_RATING) ** 2);
    
    // 期待勝率計算
    const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
    
    // レート変動計算
    let ratingChange;
    if (isWinner) {
        ratingChange = Math.round(kFactor * (1 - expectedScore));
        // 6000に近づくほど上がりにくく
        if (playerRating >= 5500) {
            ratingChange = Math.max(1, Math.round(ratingChange * 0.3));
        } else if (playerRating >= 5000) {
            ratingChange = Math.round(ratingChange * 0.6);
        }
    } else {
        // 負けた時
        ratingChange = -Math.round(kFactor * expectedScore);
        if (playerRating >= 4000) {
            ratingChange = Math.round(ratingChange * 1.5); // 高レートは負けた時により大きく下がる
        }
    }
    
    return Math.min(100, Math.max(-100, ratingChange)); // 最小-100、最大100の変動
}

// ルームコード生成
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ゲーム状態クラス
class GameState {
    constructor(player1, player2, gameId, isCustom = false) {
        this.gameId = gameId;
        this.player1 = player1;
        this.player2 = player2;
        this.isCustom = isCustom;
        
        // 山札を30枚ずつ作成（重複回数制限付き）
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
                io.to(this.player1.socketId).emit('countdown', { count });
                io.to(this.player2.socketId).emit('countdown', { count });
                count--;
            } else {
                // START!
                io.to(this.player1.socketId).emit('countdown', { count: 'START!' });
                io.to(this.player2.socketId).emit('countdown', { count: 'START!' });
                
                // ゲーム開始
                setTimeout(() => {
                    this.status = 'playing';
                    this.startForceCheck();
                    
                    // ゲーム状態を両プレイヤーに送信
                    io.to(this.player1.socketId).emit('gameUpdate', this.getGameStateForPlayer(this.player1.socketId));
                    io.to(this.player2.socketId).emit('gameUpdate', this.getGameStateForPlayer(this.player2.socketId));
                }, 1000);
                
                clearInterval(countdownInterval);
            }
        }, 1000);
    }

    generateDeck() {
        const deck = [];
        const primeCount = {}; // 各素数の出現回数を記録
        
        // 各素数の出現回数を初期化
        primes.forEach(prime => {
            primeCount[prime] = 0;
        });
        
        // 30枚のデッキを作成
        for (let i = 0; i < 30; i++) {
            let availablePrimes = primes.filter(prime => primeCount[prime] < maxPrimeCount[prime]);
            
            // 使用可能な素数がない場合（念のため）
            if (availablePrimes.length === 0) {
                availablePrimes = primes;
                // カウントをリセット
                primes.forEach(prime => {
                    primeCount[prime] = 0;
                });
            }
            
            const selectedPrime = availablePrimes[Math.floor(Math.random() * availablePrimes.length)];
            deck.push(selectedPrime);
            primeCount[selectedPrime]++;
        }
        
        // デッキをシャッフル
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        
        return deck;
    }

    generateBalancedTarget() {
        let value = 1;
        const complexity = 5 + Math.floor(Math.random() * 3); // 5-7の複雑さ
        
        for (let i = 0; i < complexity; i++) {
            value *= primes[Math.floor(Math.random() * primes.length)];
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
            return this.player1.socketId;
        }
        if (this.player2Deck.length === 0 && this.player2Cards.length === 0) {
            return this.player2.socketId;
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
        for (let prime of primes) {
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
                
                io.to(this.player1.socketId).emit('gameUpdate', this.getGameStateForPlayer(this.player1.socketId));
                io.to(this.player2.socketId).emit('gameUpdate', this.getGameStateForPlayer(this.player2.socketId));
            }
        }, 1000);
    }

    getGameStateForPlayer(playerId) {
        const isPlayer1 = playerId === this.player1.socketId;
        
        return {
            gameId: this.gameId,
            targetValue: this.targetValue,
            myCards: isPlayer1 ? this.player1Cards : this.player2Cards,
            myDeckCount: isPlayer1 ? this.player1Deck.length : this.player2Deck.length,
            opponentCards: isPlayer1 ? this.player2Cards : this.player1Cards,
            opponentDeckCount: isPlayer1 ? this.player2Deck.length : this.player1Deck.length,
            opponentName: isPlayer1 ? this.player2.displayName : this.player1.displayName,
            opponentUsername: isPlayer1 ? this.player2.username : this.player1.username, // ユーザー名追加
            opponentRating: isPlayer1 ? this.player2.rating : this.player1.rating, // レート追加
            myUsername: isPlayer1 ? this.player1.username : this.player2.username, // 自分のユーザー名追加
            myRating: isPlayer1 ? this.player1.rating : this.player2.rating, // 自分のレート追加
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
    socket.on('joinGame', async (playerData) => {
        try {
            const { username, password, isGuest } = playerData;
            
            const user = await authenticateUser(username, password, isGuest);
            
            // ソケットIDを追加
            user.socketId = socket.id;
            
            players.set(socket.id, user);
            
            socket.emit('playerRegistered', {
                id: socket.id,
                username: user.username,
                pronoun: user.pronoun,
                rating: user.rating,
                displayName: user.displayName,
                isGuest: user.is_guest,
                message: '認証完了'
            });
            
            console.log('プレイヤー登録:', user.displayName);
        } catch (error) {
            console.error('認証エラー:', error);
            socket.emit('authError', {
                message: error.message
            });
        }
    });

    // ランダムマッチング開始
    socket.on('startMatching', () => {
        const player = players.get(socket.id);
        
        if (!player) {
            socket.emit('error', { message: 'プレイヤーが登録されていません' });
            return;
        }

        // ゲストユーザーもランクマッチに参加可能に変更
        if (!waitingPlayers.includes(socket.id)) {
            waitingPlayers.push(socket.id);
            
            socket.emit('matchingStarted', {
                message: '対戦相手を探しています...'
            });
            
            console.log(`${player.displayName} がマッチング開始`);
            
            tryMatchmaking();
        }
    });

    // カスタムマッチ作成
    socket.on('createCustomRoom', () => {
        const player = players.get(socket.id);
        
        if (!player) {
            socket.emit('error', { message: 'プレイヤーが登録されていません' });
            return;
        }

        const roomCode = generateRoomCode();
        customRooms.set(roomCode, {
            host: player,
            guest: null,
            created: Date.now()
        });

        socket.emit('customRoomCreated', {
            roomCode: roomCode
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

        if (room.host.socketId === socket.id) {
            socket.emit('error', { message: '自分のルームには参加できません' });
            return;
        }

        room.guest = player;
        
        // カスタムゲーム開始
        createGame(room.host, room.guest, true);
        customRooms.delete(roomCode);

        console.log(`カスタムルーム参加: ${roomCode} by ${player.displayName}`);
    });

    // マッチングキャンセル
    socket.on('cancelMatching', () => {
        removeFromWaiting(socket.id);
        
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

        const isPlayer1 = socket.id === game.player1.socketId;
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

            io.to(game.player1.socketId).emit('gameUpdate', game.getGameStateForPlayer(game.player1.socketId));
            io.to(game.player2.socketId).emit('gameUpdate', game.getGameStateForPlayer(game.player2.socketId));
        }

        console.log(`${isPlayer1 ? game.player1.displayName : game.player2.displayName} がカードを使用: ${cardValue}`);
    });

    // 生存確認
    socket.on('heartbeat', (data) => {
        const { gameId } = data;
        const game = activeGames.get(gameId);
        
        if (game && game.status === 'playing') {
            const isPlayer1 = socket.id === game.player1.socketId;
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
        
        removeFromWaiting(socket.id);
        
        // カスタムルーム削除
        for (const [roomCode, room] of customRooms.entries()) {
            if (room.host.socketId === socket.id) {
                customRooms.delete(roomCode);
            }
        }
        
        for (const [gameId, game] of activeGames.entries()) {
            if (game.player1.socketId === socket.id || game.player2.socketId === socket.id) {
                const opponent = game.player1.socketId === socket.id ? game.player2 : game.player1;
                
                if (game.status === 'playing' || game.status === 'countdown') {
                    game.status = 'finished';
                    game.winner = opponent.socketId;
                    
                    io.to(opponent.socketId).emit('opponentDisconnected', {
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
function tryMatchmaking() {
    console.log(`マッチング試行: 待機中: ${waitingPlayers.length}人`);
    
    if (waitingPlayers.length >= 2) {
        console.log('2人以上揃いました。マッチング開始...');
        
        // レート差300以内でマッチング
        for (let i = 0; i < waitingPlayers.length - 1; i++) {
            for (let j = i + 1; j < waitingPlayers.length; j++) {
                const player1 = players.get(waitingPlayers[i]);
                const player2 = players.get(waitingPlayers[j]);
                
                if (player1 && player2) {
                    const ratingDiff = Math.abs(player1.rating - player2.rating);
                    console.log(`レート差チェック: ${player1.displayName}(${player1.rating}) vs ${player2.displayName}(${player2.rating}) = ${ratingDiff}`);
                    
                    if (ratingDiff <= 300) {
                        // マッチング成功
                        waitingPlayers.splice(j, 1); // j > i なので先に削除
                        waitingPlayers.splice(i, 1);
                        
                        console.log('レート差マッチング成功!');
                        createGame(player1, player2, false);
                        return;
                    }
                }
            }
        }
        
        // レート差300以内が見つからない場合、待ち時間が長い人同士をマッチング
        if (waitingPlayers.length >= 2) {
            const player1Id = waitingPlayers.shift();
            const player2Id = waitingPlayers.shift();
            
            const player1 = players.get(player1Id);
            const player2 = players.get(player2Id);
            
            if (player1 && player2) {
                console.log('時間経過マッチング成功!');
                createGame(player1, player2, false);
            }
        }
    } else {
        console.log('待機人数不足。マッチング待機中...');
    }
}

// ゲーム作成
function createGame(player1, player2, isCustom) {
    const gameId = `game_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const game = new GameState(player1, player2, gameId, isCustom);
    
    activeGames.set(gameId, game);
    
    io.to(player1.socketId).emit('gameStart', {
        gameId: gameId,
        opponent: player2.displayName,
        isCustom: isCustom,
        gameState: game.getGameStateForPlayer(player1.socketId)
    });
    
    io.to(player2.socketId).emit('gameStart', {
        gameId: gameId,
        opponent: player1.displayName,
        isCustom: isCustom,
        gameState: game.getGameStateForPlayer(player2.socketId)
    });
    
    console.log(`ゲーム作成: ${player1.displayName} vs ${player2.displayName} ${isCustom ? '[Custom]' : '[Ranked]'}`);
}

// ゲーム終了
function endGame(gameId) {
    const game = activeGames.get(gameId);
    
    if (!game) return;
    
    const player1 = players.get(game.player1.socketId);
    const player2 = players.get(game.player2.socketId);
    
    if (!player1 || !player2) {
        game.cleanup();
        activeGames.delete(gameId);
        return;
    }

    const isPlayer1Winner = game.winner === game.player1.socketId;
    const isPlayer2Winner = game.winner === game.player2.socketId;
    
    let ratingChanges = { player1: 0, player2: 0 };
    
    // ランクマッチでゲストではない場合のみレート変動
    if (!game.isCustom && (isPlayer1Winner || isPlayer2Winner)) {
        // プレイヤー1のレート変動（ゲストでない場合のみ）
        if (!player1.is_guest) {
            ratingChanges.player1 = calculateRatingChange(player1.rating, player2.rating, isPlayer1Winner);
            player1.rating = Math.max(1000, Math.min(6000, player1.rating + ratingChanges.player1));
            player1.displayName = `${player1.pronoun}(${player1.rating})`;
            updateUserRating(player1.id, player1.rating, isPlayer1Winner);
            players.set(game.player1.socketId, player1);
        }
        
        // プレイヤー2のレート変動（ゲストでない場合のみ）
        if (!player2.is_guest) {
            ratingChanges.player2 = calculateRatingChange(player2.rating, player1.rating, isPlayer2Winner);
            player2.rating = Math.max(1000, Math.min(6000, player2.rating + ratingChanges.player2));
            player2.displayName = `${player2.pronoun}(${player2.rating})`;
            updateUserRating(player2.id, player2.rating, isPlayer2Winner);
            players.set(game.player2.socketId, player2);
        }
    }
    
    // 結果送信
    io.to(game.player1.socketId).emit('gameEnd', {
        winner: game.winner,
        isWinner: isPlayer1Winner,
        opponentName: player2.displayName,
        ratingChange: ratingChanges.player1,
        newRating: player1.rating,
        isCustom: game.isCustom,
        isGuest: player1.is_guest
    });
    
    io.to(game.player2.socketId).emit('gameEnd', {
        winner: game.winner,
        isWinner: isPlayer2Winner,
        opponentName: player1.displayName,
        ratingChange: ratingChanges.player2,
        newRating: player2.rating,
        isCustom: game.isCustom,
        isGuest: player2.is_guest
    });
    
    console.log(`ゲーム終了: ${game.gameId}, 勝者: ${game.winner || '引き分け'}, レート変動: P1(${ratingChanges.player1}) P2(${ratingChanges.player2})`);
    
    game.cleanup();
    activeGames.delete(gameId);
}

// 待機リストから削除
function removeFromWaiting(playerId) {
    const index = waitingPlayers.indexOf(playerId);
    if (index > -1) {
        waitingPlayers.splice(index, 1);
    }
}

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
});

// データベース接続終了処理
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('データベース接続を閉じました');
        process.exit(0);
    });
});
