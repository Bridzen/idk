import { useEffect, useRef, useState } from "react";
import Peer from "peerjs";

// --- CONFIGURATION ---
const CELL = 150;
const GRID = 35; 
const WORLD_SIZE = CELL * GRID;
const MIN_LENGTH = 140;
const SPRINT_COST = 0.5;
const BASE_SPEED = 3.5;
const TURN_SPEED = 0.09; 
const MAX_ENEMIES = 2; 

// --- UTILS ---
function randPosCell() { return Math.floor(Math.random() * GRID) * CELL - WORLD_SIZE / 2; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function coll(a, b, r) { return dist(a, b) < r; }
function normalizeAngle(angle) { return Math.atan2(Math.sin(angle), Math.cos(angle)); }
function getRandomCountry() {
    const countries = ['russia', 'canada', 'germany', 'france', 'ukraine'];
    return countries[Math.floor(Math.random() * countries.length)];
}

export default function BosniaSnakeFinal() {
  const canvasRef = useRef(null);
  
  // UI STATES
  const [menuState, setMenuState] = useState("start");
  const [controlMode, setControlMode] = useState("mouse"); // 'mouse' or 'keyboard'
  const [myId, setMyId] = useState("Generating...");
  const [connectId, setConnectId] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [lobbyCount, setLobbyCount] = useState(1);
  const [myPlayerIndex, setMyPlayerIndex] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);

  // NETWORKING REFS
  const peerRef = useRef(null);
  const connections = useRef([]); 
  const hostConn = useRef(null);  
  const lastSentTime = useRef(0);

  // INPUT REFS
  const mouse = useRef({ x: 0, y: 0 });
  const keys = useRef({});
  const remoteInputs = useRef({}); 

  // GAME ENGINE STATE
  const gameState = useRef({
    mode: null,
    players: [],
    enemies: [], 
    food: [],
    mines: [],
    explosions: [],
    shakeIntensity: 0,
    gameOver: false
  });

  useEffect(() => {
    // Keyboard Listeners
    const handleDown = (e) => { keys.current[e.key.toLowerCase()] = true; };
    const handleUp = (e) => { keys.current[e.key.toLowerCase()] = false; };
    
    // Mouse Listener
    const handleMouseMove = (e) => {
        mouse.current.x = e.clientX;
        mouse.current.y = e.clientY;
    };

    window.addEventListener("keydown", handleDown);
    window.addEventListener("keyup", handleUp);
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("keydown", handleDown);
      window.removeEventListener("keyup", handleUp);
      window.removeEventListener("mousemove", handleMouseMove);
      if(peerRef.current) peerRef.current.destroy();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if(!canvas) return;
    const ctx = canvas.getContext("2d");

    const handleResize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.scale(dpr, dpr);
    };
    window.addEventListener('resize', handleResize);
    handleResize();

    let animationId;
    const loop = (timestamp) => {
      if (menuState !== "playing") {
          ctx.fillStyle = "#111";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          return;
      }
      const state = gameState.current;

      if (state.mode === 'single') {
          updateSinglePlayer();
          renderGame(ctx, canvas, 0); 
      } 
      else if (state.mode === 'multi') {
          if (isHost) {
              updateMultiplayerHost();
              if (timestamp - lastSentTime.current > 33) {
                  const payload = { type: "STATE", state: state };
                  connections.current.forEach(conn => { if (conn && conn.open) conn.send(payload); });
                  lastSentTime.current = timestamp;
              }
          } else {
              // CLIENT: Send Local Input to Host
              if (hostConn.current && hostConn.current.open) {
                  const input = getLocalInput(); // Get input based on settings
                  hostConn.current.send({ type: "INPUT", index: myPlayerIndex, keys: input });
              }
          }
          renderGame(ctx, canvas, myPlayerIndex);
      }
      animationId = requestAnimationFrame(loop);
    };
    animationId = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(animationId); window.removeEventListener('resize', handleResize); };
  }, [menuState, isHost, myPlayerIndex, controlMode]); // Dependency on controlMode

  // --- INPUT HELPER ---
  // Calculates the target angle based on the selected control mode
  const getLocalInput = () => {
      const sprint = keys.current['shift'] || keys.current['/'];
      const respawn = keys.current[' '];
      let targetAngle = null;

      if (controlMode === 'mouse') {
          // Mouse Tracking Logic
          const cx = window.innerWidth / 2;
          const cy = window.innerHeight / 2;
          targetAngle = Math.atan2(mouse.current.y - cy, mouse.current.x - cx);
      } else {
          // Keyboard (WASD/Arrows) Logic
          let dx = 0, dy = 0;
          if (keys.current['w'] || keys.current['arrowup']) dy -= 1;
          if (keys.current['s'] || keys.current['arrowdown']) dy += 1;
          if (keys.current['a'] || keys.current['arrowleft']) dx -= 1;
          if (keys.current['d'] || keys.current['arrowright']) dx += 1;
          
          // Only set angle if a key is pressed, otherwise null (keep straight)
          if (dx !== 0 || dy !== 0) {
              targetAngle = Math.atan2(dy, dx);
          }
      }
      return { targetAngle, sprint, respawn };
  };

  // --- MENU FUNCTIONS ---
  const initSinglePlayer = () => {
      if(peerRef.current) peerRef.current.destroy();
      gameState.current.mode = 'single';
      gameState.current.players = [{ 
          id: 1, active: true, x: 0, y: 0, angle: -Math.PI/2, body: [], length: 140, 
          dead: false, country: 'bosnia', colorBody: "#002F6C", scale: 18,
          kills: 0, deaths: 0 
      }];
      resetWorld(true);
      setMenuState("playing");
      setMyPlayerIndex(0);
      setIsHost(true);
  };

  const initHost = () => {
      if(peerRef.current) peerRef.current.destroy();
      const peer = new Peer(); 
      peerRef.current = peer;
      connections.current = [];

      peer.on("open", (id) => {
          setMyId(id);
          setIsHost(true);
          setMenuState("multi_lobby");
          setLobbyCount(1);
          setMyPlayerIndex(0);
      });

      peer.on("connection", (conn) => {
          if (connections.current.length >= 2) {
              conn.on("open", () => conn.send({type: "FULL"}));
              setTimeout(() => conn.close(), 500);
              return;
          }
          connections.current.push(conn);
          const newCount = connections.current.length + 1;
          setLobbyCount(newCount);
          broadcastLobbyCount(newCount);

          conn.on("open", () => {
              const pIdx = connections.current.length; 
              conn.send({ type: "WELCOME", index: pIdx, count: newCount });
          });
          conn.on("data", (data) => { if (data.type === "INPUT") remoteInputs.current[data.index] = data.keys; });
          conn.on("close", () => {
             connections.current = connections.current.filter(c => c !== conn);
             setLobbyCount(connections.current.length + 1);
             broadcastLobbyCount(connections.current.length + 1);
          });
      });
  };

  const initJoin = () => {
      if(!connectId) return;
      setIsConnecting(true);
      if(peerRef.current) peerRef.current.destroy();
      const peer = new Peer(); 
      peerRef.current = peer;

      peer.on("open", () => {
          const conn = peer.connect(connectId);
          hostConn.current = conn;
          setIsHost(false);

          conn.on("open", () => {
              setIsConnecting(false);
              setMenuState("multi_lobby");
          });

          conn.on("data", (data) => {
              if (data.type === "WELCOME") { setMyPlayerIndex(data.index); setLobbyCount(data.count); }
              if (data.type === "LOBBY_UPDATE") setLobbyCount(data.count);
              if (data.type === "START") startGameMulti(false, data.playerCount);
              if (data.type === "STATE") gameState.current = data.state;
              if (data.type === "FULL") { alert("Room is full!"); setIsConnecting(false); setMenuState("start"); }
          });

          conn.on("close", () => { alert("Host disconnected"); setIsConnecting(false); setMenuState("start"); });
          setTimeout(() => { if(!conn.open && menuState !== "multi_lobby") { alert("Could not connect. Check ID."); setIsConnecting(false); } }, 5000);
      });
      peer.on("error", (err) => { alert("Connection Error: " + err.type); setIsConnecting(false); setMenuState("start"); });
  };

  const handleHostStart = () => {
      const totalPlayers = connections.current.length + 1;
      startGameMulti(true, totalPlayers);
      connections.current.forEach(conn => { if (conn.open) conn.send({ type: "START", playerCount: totalPlayers }); });
      broadcastLobbyCount(totalPlayers);
  };

  const broadcastLobbyCount = (count) => {
      connections.current.forEach(conn => { if (conn.open) conn.send({ type: "LOBBY_UPDATE", count: count }); });
  };

  const startGameMulti = (isHostLocal, playerCount) => {
      gameState.current.mode = 'multi';
      
      const configs = [
          { country: "bosnia", cBody: "#002F6C", x: 0, y: -200 }, 
          { country: getRandomCountry(), cBody: "#FFFFFF", x: -200, y: 200 }, 
          { country: getRandomCountry(), cBody: "#FFFFFF", x: 200, y: 200 }, 
      ];

      gameState.current.players = [];
      for(let i=0; i<playerCount; i++) {
          gameState.current.players.push({
              id: i, active: true,
              x: configs[i].x, y: configs[i].y,
              angle: -Math.PI/2, body: [], length: 140, dead: false,
              country: configs[i].country, colorBody: configs[i].cBody, scale: 18,
              kills: 0, deaths: 0
          });
      }

      if (isHostLocal) resetWorld(false); 
      setMenuState("playing");
  };

  const resetWorld = (spawnBots) => {
      const state = gameState.current;
      state.food = []; state.mines = []; state.explosions = []; state.shakeIntensity = 0; state.gameOver = false;
      spawnMines(40); spawnFood(150);

      const configs = [ { x: 0, y: -200 }, { x: -200, y: 200 }, { x: 200, y: 200 } ];
      state.players.forEach((p, i) => {
          p.x = state.mode==='single' ? 0 : configs[i].x;
          p.y = state.mode==='single' ? 0 : configs[i].y;
          p.body = []; p.length = 140; p.dead = false; p.angle = -Math.PI/2; p.scale = 18;
      });
      if (spawnBots) spawnEnemies(); else state.enemies = [];
  };

  function spawnFood(n) { for(let i=0; i<n; i++) gameState.current.food.push({ x: randPosCell(), y: randPosCell() }); }
  function spawnMines(n) { gameState.current.mines = []; for(let i=0; i<n; i++) gameState.current.mines.push({ x: randPosCell(), y: randPosCell(), state: 'idle', timer: 3.0, lastTick: Date.now() }); }
  
  function spawnEnemies() {
      gameState.current.enemies = [];
      for(let i=0; i<MAX_ENEMIES; i++) {
          spawnOneEnemy();
      }
  }

  function spawnOneEnemy() {
      const colors = ["#8A2BE2", "#DC143C", "#228B22", "#FF4500", "#1E90FF", "#FFD700"];
      gameState.current.enemies.push({
          x: randPosCell(), 
          y: randPosCell(), 
          angle: Math.random()*Math.PI*2, 
          body: [], 
          length: 140 + Math.random()*200,
          width: 12, 
          speed: 2.5 + Math.random(), 
          boostSpeed: 7.5, 
          turnSpeed: 0.08, 
          alive: true, 
          color: colors[Math.floor(Math.random() * colors.length)]
      });
  }

  // --- LOGIC ---
  function updateSinglePlayer() {
      const state = gameState.current;
      const player = state.players[0];
      if(player.dead) { if (keys.current['r']) resetWorld(true); return; }
      
      // Respawn AI
      state.enemies = state.enemies.filter(e => e.alive);
      if (state.enemies.length < MAX_ENEMIES && Math.random() < 0.02) {
          spawnOneEnemy();
      }

      // USE HELPER FOR INPUT
      handlePhysics(player, getLocalInput());
      
      updateAI(player);
      updateEnvironment([player]);
  }

  function updateMultiplayerHost() {
      const state = gameState.current;
      const activePlayers = state.players.filter(p => p.active);
      
      state.players.forEach((p, i) => {
          if (!p.active) return;
          
          let input;
          if (i === 0) {
              // HOST: Use local settings
              input = getLocalInput();
          } else {
              // CLIENT: Use received input
              input = remoteInputs.current[i] || {};
          }

          if (p.dead) { 
              if (input.respawn) respawnPlayer(p, 0); 
          } else { 
              handlePhysics(p, input); 
          }
      });

      // Check Collisions between players
      for(let i=0; i<state.players.length; i++) {
          for(let j=i+1; j<state.players.length; j++) {
              const pA = state.players[i]; const pB = state.players[j];
              if(!pA.active || !pB.active || pA.dead || pB.dead) continue;
              
              if (coll(pA, pB, pA.scale + pB.scale)) { 
                  killPlayer(pA, null); 
                  killPlayer(pB, null); 
              }
              else if (checkBodyCollision(pA, pB)) {
                  killPlayer(pA, pB); 
              }
              else if (checkBodyCollision(pB, pA)) {
                  killPlayer(pB, pA);
              }
          }
      }
      updateEnvironment(activePlayers);
  }

  function handlePhysics(p, input) {
      // Input now provides targetAngle and sprint bool
      if (input.targetAngle !== undefined && input.targetAngle !== null) {
          let diff = normalizeAngle(input.targetAngle - p.angle);
          // Apply Turn Speed Limit
          if (Math.abs(diff) < TURN_SPEED) {
              p.angle = input.targetAngle;
          } else if (diff > 0) {
              p.angle += TURN_SPEED;
          } else {
              p.angle -= TURN_SPEED;
          }
          p.angle = normalizeAngle(p.angle);
      }
      
      let spd = BASE_SPEED;
      if(input.sprint && p.length > MIN_LENGTH) { spd = BASE_SPEED * 1.8; p.length -= SPRINT_COST; }
      
      p.x += Math.cos(p.angle) * spd; 
      p.y += Math.sin(p.angle) * spd;
      
      if (Math.abs(p.x) > WORLD_SIZE/2 || Math.abs(p.y) > WORLD_SIZE/2) killPlayer(p, null);
      
      p.body.unshift({x: p.x, y: p.y}); 
      while(p.body.length > p.length) p.body.pop();
  }

  function updateEnvironment(activePlayers) {
      const state = gameState.current; const now = Date.now();
      for (let i = state.mines.length - 1; i >= 0; i--) {
          let m = state.mines[i];
          if (m.state === 'idle') {
              let triggered = false;
              activePlayers.forEach(p => { if (!p.dead && dist(p, m) < 200) triggered = true; });
              state.enemies.forEach(e => { if (e.alive && dist(e, m) < 200) triggered = true; });
              if (triggered) { m.state = 'triggered'; m.lastTick = now; }
          } else if (m.state === 'triggered') {
              if (now - m.lastTick > m.timer * 1000) {
                  createExplosion(m.x, m.y);
                  activePlayers.forEach(p => { if (!p.dead && dist(p, m) < 300) killPlayer(p, null); });
                  state.enemies.forEach(e => { if (e.alive && dist(e, m) < 300) killEnemy(e); });
                  state.mines.splice(i, 1);
              }
          }
      }
      for(let i=state.explosions.length-1; i>=0; i--) { state.explosions[i].radius += 15; state.explosions[i].alpha -= 0.05; if(state.explosions[i].alpha <= 0) state.explosions.splice(i, 1); }
      if (state.food.length < 150) spawnFood(5);
      for(let i=state.food.length-1; i>=0; i--) {
          let f = state.food[i];
          activePlayers.forEach(p => { 
              if(!p.dead && coll(p, f, p.scale+5)) { 
                  state.food.splice(i, 1); 
                  p.length += 8; 
                  p.scale = Math.min(200, p.scale + 0.5); 
              } 
          });
      }
  }

  // --- SMART AI LOGIC ---
  function updateAI(player) {
      const state = gameState.current;
      const viewDist = 400; 

      // Determine Roles
      let closestEnemy = null;
      let closestDist = Infinity;
      state.enemies.forEach(e => {
          if(!e.alive) return;
          const d = dist(e, player);
          if (d < closestDist) { closestDist = d; closestEnemy = e; }
      });

      state.enemies.forEach((enemy) => {
          if (!enemy.alive) return;
          enemy.width = 12 + Math.min(33, (enemy.length - 140) / 10);
          
          let forceSprint = false;
          let targetAngle = enemy.angle;
          let isHunter = (enemy === closestEnemy) && !player.dead;

          // PHASE 0: CRITICAL MINE EVASION
          let panicMine = null;
          let minMineDist = Infinity;

          for (let m of state.mines) {
              const d = dist(enemy, m);
              const safeZone = (m.state === 'triggered') ? 400 : 250;
              if (d < safeZone && d < minMineDist) { minMineDist = d; panicMine = m; }
          }

          if (panicMine) {
              const angleAway = Math.atan2(enemy.y - panicMine.y, enemy.x - panicMine.x);
              targetAngle = angleAway;
              forceSprint = true; 
          } 
          else {
              // PHASE 1: RAYCASTING
              const feelers = [
                  { angle: enemy.angle - 0.6, dist: viewDist, type: 'left' },
                  { angle: enemy.angle - 0.3, dist: viewDist + 50, type: 'midLeft' },
                  { angle: enemy.angle,       dist: viewDist + 100, type: 'center' },
                  { angle: enemy.angle + 0.3, dist: viewDist + 50, type: 'midRight' },
                  { angle: enemy.angle + 0.6, dist: viewDist, type: 'right' }
              ];

              let dangerLeft = 0;
              let dangerRight = 0;
              let blockedCenter = false;

              const checkPointDanger = (px, py) => {
                  const limit = WORLD_SIZE/2 - 50;
                  if (px < -limit || px > limit || py < -limit || py > limit) return 100;
                  for (let m of state.mines) { if (dist({x:px, y:py}, m) < 120) return 200; }
                  for (let other of state.enemies) {
                      if (other === enemy || !other.alive) continue;
                      for (let i = 0; i < other.body.length; i+=4) { if (dist({x:px, y:py}, other.body[i]) < other.width + 30) return 100; }
                  }
                  if (!player.dead) {
                      for (let i = 0; i < player.body.length; i+=4) { if (dist({x:px, y:py}, player.body[i]) < player.scale + 30) return 100; }
                  }
                  return 0;
              };

              feelers.forEach(f => {
                  const steps = 6;
                  for(let s=1; s<=steps; s++) {
                      const checkDist = (f.dist / steps) * s;
                      const cx = enemy.x + Math.cos(f.angle) * checkDist;
                      const cy = enemy.y + Math.sin(f.angle) * checkDist;
                      const danger = checkPointDanger(cx, cy);
                      if (danger > 0) {
                          if (f.type.includes('left') || f.type.includes('Left')) dangerLeft += danger / s; 
                          if (f.type.includes('right') || f.type.includes('Right')) dangerRight += danger / s;
                          if (f.type === 'center') blockedCenter = true;
                      }
                  }
              });

              // PHASE 2: DECISION MAKING
              if (dangerLeft > 0 || dangerRight > 0 || blockedCenter) {
                  if (dangerLeft > dangerRight) targetAngle += 1.8; 
                  else if (dangerRight > dangerLeft) targetAngle -= 1.8; 
                  else targetAngle += 2.0; 
              } 
              else if (isHunter) {
                  const distToPlayer = dist(enemy, player);
                  const playerSpeed = (player.length < player.length - 1) ? BASE_SPEED * 1.8 : BASE_SPEED; 
                  const lookAheadFrames = Math.min(60, distToPlayer / 5);
                  
                  const predX = player.x + Math.cos(player.angle) * playerSpeed * lookAheadFrames;
                  const predY = player.y + Math.sin(player.angle) * playerSpeed * lookAheadFrames;

                  const attackAngle = Math.atan2(predY - enemy.y, predX - enemy.x);
                  targetAngle = attackAngle;

                  const angleDiff = Math.abs(normalizeAngle(targetAngle - enemy.angle));
                  if (angleDiff < 0.4 && distToPlayer < 700 && distToPlayer > 100) {
                      forceSprint = true;
                  }
              }
              else {
                  if (!player.dead && dist(enemy, player) < 500) {
                       const angleAway = Math.atan2(enemy.y - player.y, enemy.x - player.x);
                       targetAngle = angleAway;
                       forceSprint = true; 
                  } else {
                      let closestFood = null;
                      let minFoodDist = Infinity;
                      state.food.forEach(f => {
                          const d = dist(enemy, f);
                          if (d < minFoodDist && d < 600) { minFoodDist = d; closestFood = f; }
                      });
                      if (closestFood) {
                          targetAngle = Math.atan2(closestFood.y - enemy.y, closestFood.x - enemy.x);
                      }
                  }
              }
          }

          // MOVEMENT EXECUTION
          let diff = normalizeAngle(targetAngle - enemy.angle);
          const turn = forceSprint ? enemy.turnSpeed * 1.5 : enemy.turnSpeed;
          
          if (Math.abs(diff) < turn) enemy.angle = targetAngle;
          else if (diff > 0) enemy.angle += turn;
          else enemy.angle -= turn;
          enemy.angle = normalizeAngle(enemy.angle);

          const spd = (forceSprint && enemy.length > 145) ? enemy.boostSpeed : enemy.speed;
          if (forceSprint && enemy.length > 145) enemy.length -= 0.3;

          enemy.x += Math.cos(enemy.angle) * spd; 
          enemy.y += Math.sin(enemy.angle) * spd;
          
          enemy.body.unshift({ x: enemy.x, y: enemy.y }); 
          while (enemy.body.length > enemy.length) enemy.body.pop();

          for(let i=state.food.length-1; i>=0; i--) { 
              if(coll(enemy, state.food[i], enemy.width+10)) { state.food.splice(i,1); enemy.length+=12; } 
          }
          if (!player.dead) {
              if (coll(player, enemy, player.scale + enemy.width)) killPlayer(player, null);
              if (checkBodyCollision(player, enemy)) killPlayer(player, null);
              for(let j=0; j<player.body.length; j+=2) if (coll(enemy, player.body[j], enemy.width + player.scale)) killEnemy(enemy);
          }
      });
  }

  function createExplosion(x, y) { gameState.current.explosions.push({ x, y, radius: 10, alpha: 1.0 }); gameState.current.shakeIntensity = 30; }
  
  function killPlayer(victim, killer) { 
      if(victim.dead) return; 
      victim.dead = true;
      victim.deaths = (victim.deaths || 0) + 1;
      if (killer) { killer.kills = (killer.kills || 0) + 1; }
      createExplosion(victim.x, victim.y); 
      const pieces = Math.min(60, victim.body.length/2); 
      for(let k=0; k<pieces; k++) if(victim.body[k*3]) gameState.current.food.push({x: victim.body[k*3].x, y: victim.body[k*3].y}); 
  }

  function respawnPlayer(p, startX) { p.x = startX || randPosCell(); p.y = 0; p.body = []; p.length = 140; p.dead = false; p.angle = -Math.PI/2; p.scale = 18; }
  function killEnemy(e) { if(!e.alive) return; e.alive = false; const pieces = Math.min(40, e.body.length/2); for(let k=0; k<pieces; k++) if(e.body[k*4]) gameState.current.food.push({x: e.body[k*4].x, y: e.body[k*4].y}); }
  
  function checkBodyCollision(attacker, victim) { 
      const aR = attacker.scale || attacker.width || 15;
      const vR = victim.scale || victim.width || 15;
      for(let i=5; i<victim.body.length; i+=2) {
          if (coll(attacker, victim.body[i], aR + vR - 5)) return true; 
      }
      return false; 
  }

  // --- RENDER ---
  function renderGame(ctx, canvas, pIdx) {
      const state = gameState.current;
      const dpr = window.devicePixelRatio || 1;
      const me = state.players[pIdx] || state.players[0];

      // Smooth Zoom
      const startScale = 18;
      const zoom = Math.max(0.25, 0.6 * (30 / (30 + (me.scale - startScale) * 0.4)));

      let sx=0, sy=0;
      if(state.shakeIntensity > 0) { sx=(Math.random()-0.5)*state.shakeIntensity; sy=(Math.random()-0.5)*state.shakeIntensity; state.shakeIntensity*=0.9; }

      const offsetX = me.x - (canvas.width / dpr) / (2 * zoom);
      const offsetY = me.y - (canvas.height / dpr) / (2 * zoom);

      ctx.clearRect(0,0,canvas.width, canvas.height);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(zoom, zoom);

      // Grid
      const half = WORLD_SIZE/2;
      ctx.lineWidth=12; ctx.strokeStyle="rgba(255,0,0,0.9)"; ctx.strokeRect(-offsetX-half,-offsetY-half,WORLD_SIZE,WORLD_SIZE);
      ctx.lineWidth=1; ctx.strokeStyle="rgba(255,255,255,0.05)";
      ctx.beginPath();
      const startX = Math.floor((offsetX-canvas.width/2)/CELL)*CELL, endX = startX+canvas.width+CELL*2;
      const startY = Math.floor((offsetY-canvas.height/2)/CELL)*CELL, endY = startY+canvas.height+CELL*2;
      for(let x=startX; x<=endX; x+=CELL) if(x>=-half && x<=half) { ctx.moveTo(x-offsetX, -half-offsetY); ctx.lineTo(x-offsetX, half-offsetY); }
      for(let y=startY; y<=endY; y+=CELL) if(y>=-half && y<=half) { ctx.moveTo(-half-offsetX, y-offsetY); ctx.lineTo(half-offsetX, y-offsetY); }
      ctx.stroke();

      const drawObj = (obj, color, size) => {
          if(obj.x-offsetX < -500 || obj.x-offsetX > canvas.width/zoom+500) return;
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(obj.x-offsetX, obj.y-offsetY, size, 0, Math.PI*2); ctx.fill();
      };

      state.mines.forEach(m => {
          const x=m.x-offsetX, y=m.y-offsetY;
          if(m.state==='triggered' && Math.floor(Date.now()/100)%2===0) { ctx.fillStyle="rgba(255,0,0,0.3)"; ctx.beginPath(); ctx.arc(x,y,200,0,Math.PI*2); ctx.fill(); }
          ctx.save(); ctx.beginPath(); ctx.arc(x,y,25,0,Math.PI*2); ctx.clip();
          ctx.fillStyle="#C6363C"; ctx.fillRect(x-25,y-25,50,17); ctx.fillStyle="#0C4076"; ctx.fillRect(x-25,y-8,50,17); ctx.fillStyle="#FFFFFF"; ctx.fillRect(x-25,y+9,50,17);
          ctx.strokeStyle="rgba(0,0,0,0.5)"; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(x,y,25,0,Math.PI*2); ctx.stroke(); ctx.restore();
      });
      state.food.forEach(f => drawObj(f, "orange", 10));
      
      state.enemies.forEach(e => {
          if(!e.alive) return;
          ctx.fillStyle = e.color;
          for(let i=e.body.length-1; i>=0; i-=2) { ctx.beginPath(); ctx.arc(e.body[i].x-offsetX, e.body[i].y-offsetY, e.width, 0, Math.PI*2); ctx.fill(); }
          ctx.beginPath(); ctx.arc(e.x-offsetX, e.y-offsetY, e.width, 0, Math.PI*2); ctx.fill();
      });

      // DRAW PLAYERS
      state.players.forEach(p => {
          if(!p.active || p.dead) return;
          if(p.x-offsetX < -500 || p.x-offsetX > canvas.width/zoom+500) { if(p.y-offsetY < -500 || p.y-offsetY > canvas.height/zoom+500) return; }
          
          ctx.fillStyle = p.colorBody;
          for(let i=p.body.length-1; i>=0; i--) { if(i<p.body.length-10 && i%2!==0) continue; ctx.beginPath(); ctx.arc(p.body[i].x-offsetX, p.body[i].y-offsetY, p.scale*0.65, 0, Math.PI*2); ctx.fill(); }
          
          const hx = p.x-offsetX; const hy = p.y-offsetY; const r = p.scale*0.8;
          ctx.save();
          ctx.translate(hx, hy); ctx.rotate(p.angle + Math.PI/2); 
          
          ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.clip(); 

          if (p.country === 'bosnia') {
              ctx.fillStyle = "#002F6C"; ctx.fillRect(-r, -r, r*2, r*2); 
              ctx.fillStyle = "#FECB00"; 
              ctx.beginPath(); ctx.moveTo(r*0.2, -r); ctx.lineTo(r*0.2, r); ctx.lineTo(r, -r*0.5); ctx.fill();
              ctx.fillStyle = "white"; 
              for(let i=0; i<5; i++) { ctx.beginPath(); ctx.arc(-r*0.2, -r*0.6 + (i*r*0.4), r*0.1, 0, Math.PI*2); ctx.fill(); }
          } else if (p.country === 'russia') {
              ctx.fillStyle = "white"; ctx.fillRect(-r, -r, r*2, r*2/3);
              ctx.fillStyle = "#0039A6"; ctx.fillRect(-r, -r + r*2/3, r*2, r*2/3);
              ctx.fillStyle = "#D52B1E"; ctx.fillRect(-r, -r + 2*r*2/3, r*2, r*2/3);
          } else if (p.country === 'germany') {
               ctx.fillStyle = "black"; ctx.fillRect(-r, -r, r*2, r*2/3);
               ctx.fillStyle = "#DD0000"; ctx.fillRect(-r, -r + r*2/3, r*2, r*2/3);
               ctx.fillStyle = "#FFCC00"; ctx.fillRect(-r, -r + 2*r*2/3, r*2, r*2/3);
          } else if (p.country === 'france') {
               ctx.fillStyle = "#0055A4"; ctx.fillRect(-r, -r, r*2/3, r*2);
               ctx.fillStyle = "white"; ctx.fillRect(-r + r*2/3, -r, r*2/3, r*2);
               ctx.fillStyle = "#EF4135"; ctx.fillRect(-r + 2*r*2/3, -r, r*2/3, r*2);
          } else if (p.country === 'canada') {
              ctx.fillStyle = "#FF0000"; ctx.fillRect(-r, -r, r*2/4, r*2);
              ctx.fillStyle = "#FFFFFF"; ctx.fillRect(-r + r*2/4, -r, r, r*2);
              ctx.fillStyle = "#FF0000"; ctx.fillRect(r/2, -r, r*2/4, r*2);
              ctx.fillStyle = "#FF0000"; ctx.beginPath(); ctx.moveTo(0, -r*0.4); ctx.lineTo(r*0.3, 0); ctx.lineTo(0, r*0.4); ctx.lineTo(-r*0.3, 0); ctx.fill();
          } else if (p.country === 'ukraine') {
              ctx.fillStyle = "#0057B8"; ctx.fillRect(-r, -r, r*2, r);
              ctx.fillStyle = "#FFD700"; ctx.fillRect(-r, 0, r*2, r);
          } else {
              ctx.fillStyle = p.colorHead; ctx.fillRect(-r, -r, r*2, r*2);
          }

          ctx.restore();
          ctx.save(); ctx.translate(hx, hy); ctx.rotate(p.angle);
          ctx.fillStyle="white"; ctx.beginPath(); ctx.arc(p.scale*0.2, -p.scale*0.3, 3, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(p.scale*0.2, p.scale*0.3, 3, 0, Math.PI*2); ctx.fill(); 
          ctx.restore();
      });

      state.explosions.forEach(ex => { ctx.fillStyle=`rgba(255,69,0,${ex.alpha})`; ctx.beginPath(); ctx.arc(ex.x-offsetX, ex.y-offsetY, ex.radius, 0, Math.PI*2); ctx.fill(); });
      ctx.restore(); // END WORLD RENDER

      // UI Overlays
      const screenW = (canvas.width / dpr) / zoom;
      const screenH = (canvas.height / dpr) / zoom;
      const cx = (canvas.width / dpr) / 2;
      const cy = (canvas.height / dpr) / 2;

      if (state.mode === 'multi') {
        const boardX = (canvas.width / dpr) - 160;
        const boardY = 20;
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.roundRect(boardX, boardY, 140, 20 + (state.players.length * 25), 5); ctx.fill();
        ctx.fillStyle = "#FFD700"; ctx.font = "bold 14px Arial"; ctx.textAlign = "center"; ctx.fillText("LEADERBOARD", boardX + 70, boardY + 20);
        ctx.textAlign = "left"; ctx.font = "12px Arial";
        state.players.forEach((p, idx) => {
           if(!p.active) return;
           ctx.fillStyle = p.id === me.id ? "#00FF00" : "white";
           ctx.fillText(`P${p.id + 1}`, boardX + 10, boardY + 45 + (idx*25));
           ctx.textAlign = "right"; ctx.fillStyle = "#FF4444";
           ctx.fillText(`${p.kills}K / ${p.deaths}D`, boardX + 130, boardY + 45 + (idx*25));
           ctx.textAlign = "left";
        });
      }

      if (state.mode === 'multi') {
        state.players.forEach(p => {
            if (p.id === me.id || !p.active || p.dead) return;
            const dx = p.x - me.x; const dy = p.y - me.y;
            if (Math.abs(dx) > screenW/2.2 || Math.abs(dy) > screenH/2.2) {
                const angle = Math.atan2(dy, dx);
                const radius = Math.min(screenW, screenH) * 0.3 * zoom;
                ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle); ctx.translate(radius + 150, 0); 
                ctx.fillStyle = "#FF4444"; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-10, -8); ctx.lineTo(-10, 8); ctx.fill();
                ctx.rotate(-angle); ctx.fillStyle = "white"; ctx.font = "bold 16px Arial"; ctx.textAlign = "center";
                ctx.fillText(`${Math.round(dist(me, p)/10)}m`, 0, 25); ctx.restore();
            }
        });
      }

      if(me.dead) {
          ctx.fillStyle="white"; ctx.font="bold 40px Arial"; ctx.textAlign="center";
          ctx.fillText("YOU DIED", (canvas.width/dpr)/2, (canvas.height/dpr)/2-50);
          ctx.font="20px Arial";
          ctx.fillText(state.mode==='single' ? "Press R to Restart" : "Press SPACE to Respawn", (canvas.width/dpr)/2, (canvas.height/dpr)/2);
      }
  }

  return (
    <div className="relative w-full h-screen bg-[#111] overflow-hidden">
      {menuState === "start" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white z-50 bg-[#111]">
          <h1 className="text-5xl font-bold mb-12 text-yellow-500 tracking-wider">BOSNIA SNAKE</h1>
          
          <div className="mb-8 flex gap-4 bg-gray-800 p-2 rounded">
              <button 
                onClick={() => setControlMode('mouse')} 
                className={`px-6 py-2 rounded font-bold ${controlMode==='mouse' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
              >
                MOUSE
              </button>
              <button 
                onClick={() => setControlMode('keyboard')} 
                className={`px-6 py-2 rounded font-bold ${controlMode==='keyboard' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
              >
                KEYBOARD (WASD)
              </button>
          </div>

          <div className="flex flex-col gap-6">
            <button onClick={initSinglePlayer} className="bg-blue-600 hover:bg-blue-500 text-white w-64 py-4 rounded text-xl font-bold transition">SINGLE PLAYER</button>
            <button onClick={() => setMenuState("multi_menu")} className="bg-red-600 hover:bg-red-500 text-white w-64 py-4 rounded text-xl font-bold transition">MULTIPLAYER</button>
          </div>
        </div>
      )}

      {menuState === "multi_menu" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white z-50 bg-[#111]">
          <h1 className="text-4xl font-bold mb-8 text-red-500">MULTIPLAYER LOBBY</h1>
          <div className="flex gap-8">
            <div className="bg-gray-800 p-6 rounded-lg text-center">
              <h2 className="text-xl font-bold mb-4">Host Game</h2>
              <button onClick={initHost} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded font-bold">Create Room</button>
            </div>
            <div className="bg-gray-800 p-6 rounded-lg text-center">
              <h2 className="text-xl font-bold mb-4">Join Game</h2>
              <input type="text" placeholder="Paste Room ID" value={connectId} onChange={(e) => setConnectId(e.target.value)} className="block w-full mb-4 px-3 py-2 text-black rounded" />
              {isConnecting ? (
                  <button disabled className="bg-gray-600 text-white px-6 py-3 rounded font-bold cursor-not-allowed">Joining...</button>
              ) : (
                  <button onClick={initJoin} className="bg-green-600 hover:bg-green-500 text-white px-6 py-3 rounded font-bold">Connect</button>
              )}
            </div>
          </div>
          <button onClick={() => setMenuState("start")} className="mt-8 text-gray-400 hover:text-white">Back</button>
        </div>
      )}

      {menuState === "multi_lobby" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white z-50 bg-black/90">
          <h2 className="text-3xl mb-6 text-yellow-400">{isHost ? "LOBBY (HOST)" : "YOU'RE IN!"}</h2>
          <div className="bg-gray-900 p-8 rounded-lg text-center border border-gray-700 min-w-[400px]">
            {isHost && (
                <>
                <p className="mb-2 text-gray-400">Share this ID:</p>
                <div className="text-xl font-mono font-bold text-white bg-black p-2 rounded mb-6 break-all border border-gray-600 select-all">
                    {myId || "Generating..."}
                </div>
                </>
            )}
            
            <div className="text-2xl mb-8 flex flex-col gap-2">
              <div className="text-white">Players: <span className="text-green-400">{lobbyCount}/3</span></div>
              {!isHost && <div className="text-sm text-yellow-500 animate-pulse">Waiting for host to start...</div>}
            </div>

            {isHost && (
              <button onClick={handleHostStart} className="bg-green-600 hover:bg-green-500 text-white w-full py-4 rounded text-xl font-bold transition">
                START GAME
              </button>
            )}
          </div>
          <button onClick={() => window.location.reload()} className="mt-8 text-red-500 hover:text-red-400 underline">Leave Lobby</button>
        </div>
      )}

      {menuState === "playing" && gameState.current.mode === "multi" && (
        <div className="absolute top-4 left-4 text-white font-bold bg-black/50 p-2 rounded">
            You are: <span style={{color: myPlayerIndex===0?"#FFD700":myPlayerIndex===1?"#FF0000":"#32CD32"}}>PLAYER {myPlayerIndex+1}</span>
        </div>
      )}
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
