import React, { useRef, useEffect } from 'react';

/**
 * SolarSystem — Two modes:
 * 1. ORBIT mode (default): Sun centered, planets orbit with wide spacing, asteroid belt
 * 2. TRANSFER mode: Sun left, planets in a line, rocket flies Mercury→Neptune
 *
 * Planets rendered using SVG image textures for realistic appearance.
 */

const PLANET_DATA = [
    { name: 'Mercury', size: 5, orbitR: 0.08, speed: 0.008, src: '/planets/mercury.svg' },
    { name: 'Venus', size: 8, orbitR: 0.13, speed: 0.006, src: '/planets/venus.svg' },
    { name: 'Earth', size: 9, orbitR: 0.18, speed: 0.005, src: '/planets/earth.svg', moon: true },
    { name: 'Mars', size: 6, orbitR: 0.23, speed: 0.004, src: '/planets/mars.svg' },
    { name: 'Jupiter', size: 22, orbitR: 0.37, speed: 0.002, src: '/planets/jupiter.svg' },
    { name: 'Saturn', size: 18, orbitR: 0.47, speed: 0.0015, src: '/planets/saturn.svg', hasRing: true },
    { name: 'Uranus', size: 13, orbitR: 0.57, speed: 0.001, src: '/planets/uranus.svg' },
    { name: 'Neptune', size: 12, orbitR: 0.66, speed: 0.0007, src: '/planets/neptune.svg' },
];

const ASTEROID_BELT_R = 0.30;
const ASTEROID_COUNT = 80;

function createStars(count, w, h) {
    const stars = [];
    for (let i = 0; i < count; i++) {
        stars.push({
            x: Math.random() * w, y: Math.random() * h,
            size: 0.3 + Math.random() * 1.0,
            alpha: 0.15 + Math.random() * 0.4,
            twinkle: Math.random() * Math.PI * 2,
            twinkleSpeed: 0.005 + Math.random() * 0.012,
        });
    }
    return stars;
}

function createAsteroids(count) {
    const asteroids = [];
    for (let i = 0; i < count; i++) {
        asteroids.push({
            angle: Math.random() * Math.PI * 2,
            radiusOffset: (Math.random() - 0.5) * 0.04,
            speed: 0.001 + Math.random() * 0.002,
            size: 1.2 + Math.random() * 2.0,
            alpha: 0.25 + Math.random() * 0.35,
        });
    }
    return asteroids;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function drawShip(ctx, x, y, size, progress) {
    ctx.save();
    ctx.translate(x, y);
    const flameLen = 8 + progress * 12;
    const grad = ctx.createLinearGradient(-size, 0, -size - flameLen, 0);
    grad.addColorStop(0, 'rgba(255,200,50,0.9)');
    grad.addColorStop(0.4, 'rgba(255,80,20,0.6)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-size * 0.6, 0);
    ctx.lineTo(-size - flameLen, -2.5 - Math.random() * 1.5);
    ctx.lineTo(-size - flameLen, 2.5 + Math.random() * 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e0e0e0';
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.3, -size * 0.4);
    ctx.lineTo(-size * 0.6, -size * 0.35);
    ctx.lineTo(-size * 0.6, size * 0.35);
    ctx.lineTo(-size * 0.3, size * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#64b5f6';
    ctx.beginPath();
    ctx.arc(size * 0.3, 0, size * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

export function SolarSystem({ darkMode, transferProgress = 0, isTransferring = false }) {
    const canvasRef = useRef(null);
    const starsRef = useRef([]);
    const asteroidsRef = useRef([]);
    const imagesRef = useRef({}); // loaded planet images
    const sunImgRef = useRef(null);
    const animRef = useRef(null);
    const timeRef = useRef(0);
    const modeRef = useRef(0); // 0 = orbit, 1 = linear transfer

    // Load planet + sun images once
    useEffect(() => {
        // Load planet SVGs (with cache-bust)
        const v = Date.now();
        PLANET_DATA.forEach(p => {
            const img = new Image();
            img.src = p.src + '?v=' + v;
            imagesRef.current[p.name] = img;
        });
        // Load sun SVG
        const sunImg = new Image();
        sunImg.src = '/planets/sun.svg?v=' + v;
        sunImgRef.current = sunImg;
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            starsRef.current = createStars(50, canvas.width, canvas.height);
        };
        resize();
        asteroidsRef.current = createAsteroids(ASTEROID_COUNT);
        window.addEventListener('resize', resize);

        const animate = () => {
            const W = canvas.width;
            const H = canvas.height;
            timeRef.current += 1;
            const t = timeRef.current;

            const targetMode = isTransferring ? 1 : 0;
            modeRef.current += (targetMode - modeRef.current) * 0.03;
            const mode = modeRef.current;

            ctx.clearRect(0, 0, W, H);

            // ── Stars ─────────────────────────────────────────
            for (const s of starsRef.current) {
                s.twinkle += s.twinkleSpeed;
                ctx.globalAlpha = s.alpha * (0.6 + Math.sin(s.twinkle) * 0.4);
                ctx.fillStyle = darkMode ? '#dbe4ff' : '#888';
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // ── Sun ───────────────────────────────────────────
            const orbitSunX = W * 0.5;
            const orbitSunY = H * 0.5;
            const linearSunX = W * 0.05;
            const linearSunY = H * 0.55;
            const sunX = lerp(orbitSunX, linearSunX, mode);
            const sunY = lerp(orbitSunY, linearSunY, mode);
            const sunR = Math.min(W, H) * lerp(0.05, 0.035, mode);

            // Corona glow (always procedural for the glow effect)
            for (let i = 3; i >= 0; i--) {
                const r = sunR + i * sunR * 0.8;
                const g = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, r);
                g.addColorStop(0, `rgba(255,200,50,${0.06 - i * 0.012})`);
                g.addColorStop(1, 'transparent');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
                ctx.fill();
            }

            // Sun image (spinning)
            const sunImg = sunImgRef.current;
            if (sunImg && sunImg.complete && sunImg.naturalWidth > 0) {
                ctx.save();
                ctx.translate(sunX, sunY);
                ctx.rotate(t * 0.001);
                const d = sunR * 2;
                ctx.drawImage(sunImg, -d / 2, -d / 2, d, d);
                ctx.restore();
            } else {
                // Fallback procedural sun
                const sg = ctx.createRadialGradient(sunX - sunR * 0.2, sunY - sunR * 0.2, 0, sunX, sunY, sunR);
                sg.addColorStop(0, '#fff8e1');
                sg.addColorStop(0.3, '#ffd54f');
                sg.addColorStop(0.7, '#ff9800');
                sg.addColorStop(1, '#e65100');
                ctx.fillStyle = sg;
                ctx.beginPath();
                ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
                ctx.fill();
            }

            // ── Orbit scale ──
            const orbitScale = Math.max(W, H) * 0.6;

            // ── Orbit paths ────────────────────────────────────
            if (mode < 0.95) {
                const orbitAlpha = 0.15 * (1 - mode);
                ctx.strokeStyle = darkMode
                    ? `rgba(255,255,255,${orbitAlpha})`
                    : `rgba(0,0,0,${orbitAlpha})`;
                ctx.lineWidth = 1;
                for (const p of PLANET_DATA) {
                    const r = orbitScale * p.orbitR;
                    ctx.beginPath();
                    ctx.ellipse(orbitSunX, orbitSunY, r, r * 0.45, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                // Asteroid belt
                const beltR = orbitScale * ASTEROID_BELT_R;
                ctx.setLineDash([3, 5]);
                ctx.strokeStyle = darkMode
                    ? `rgba(255,255,255,${orbitAlpha * 0.5})`
                    : `rgba(0,0,0,${orbitAlpha * 0.5})`;
                ctx.beginPath();
                ctx.ellipse(orbitSunX, orbitSunY, beltR, beltR * 0.45, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // ── Asteroid Belt ─────────────────────────────────
            if (mode < 0.8) {
                const beltAlpha = 0.4 * (1 - mode);
                for (const a of asteroidsRef.current) {
                    a.angle += a.speed;
                    const r = orbitScale * (ASTEROID_BELT_R + a.radiusOffset);
                    const ax = orbitSunX + Math.cos(a.angle) * r;
                    const ay = orbitSunY + Math.sin(a.angle) * r * 0.45;
                    ctx.globalAlpha = a.alpha * beltAlpha;
                    ctx.fillStyle = darkMode ? '#9e9e9e' : '#757575';
                    ctx.beginPath();
                    ctx.arc(ax, ay, a.size, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;
            }

            // ── Planets ───────────────────────────────────────
            const planetPositions = [];

            PLANET_DATA.forEach((p, i) => {
                const orbitRadius = orbitScale * p.orbitR;
                // Start aligned at angle 0, then spread naturally based on their unique speeds
                const angle = t * p.speed;
                const orbitPX = orbitSunX + Math.cos(angle) * orbitRadius;
                const orbitPY = orbitSunY + Math.sin(angle) * orbitRadius * 0.45;

                const linearStartX = W * 0.12;
                const linearEndX = W * 0.93;
                const linearSpacing = (linearEndX - linearStartX) / (PLANET_DATA.length - 1);
                const linearPX = linearStartX + linearSpacing * i;
                const linearPY = linearSunY;

                const px = lerp(orbitPX, linearPX, mode);
                const py = lerp(orbitPY, linearPY, mode);
                planetPositions.push({ x: px, y: py, linearX: linearPX });

                // Draw planet image
                const img = imagesRef.current[p.name];
                const drawSize = p.hasRing ? p.size * 2.8 : p.size * 2;

                if (img && img.complete && img.naturalWidth > 0) {
                    ctx.drawImage(img, px - drawSize / 2, py - drawSize / 2, drawSize, drawSize);
                } else {
                    // Fallback: colored circle
                    ctx.fillStyle = ['#b0b0b0', '#e8c56d', '#4a90d9', '#c1440e', '#c88b3a', '#e0c77d', '#7ec8e3', '#3b5ddb'][i];
                    ctx.beginPath();
                    ctx.arc(px, py, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }

                // 3D specular highlight (smaller for ringed planets)
                const shineR = p.hasRing ? p.size * 0.5 : p.size;
                ctx.globalAlpha = 0.2;
                const shine = ctx.createRadialGradient(
                    px - shineR * 0.3, py - shineR * 0.3, 0,
                    px, py, shineR
                );
                shine.addColorStop(0, 'rgba(255,255,255,0.5)');
                shine.addColorStop(0.35, 'rgba(255,255,255,0.1)');
                shine.addColorStop(1, 'transparent');
                ctx.fillStyle = shine;
                ctx.beginPath();
                ctx.arc(px, py, shineR, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;

                // Earth's moon
                if (p.moon) {
                    const ma = t * 0.015;
                    const mx = px + Math.cos(ma) * (p.size + 7);
                    const my = py + Math.sin(ma) * (p.size + 5);
                    ctx.fillStyle = '#c0c0c0';
                    ctx.beginPath();
                    ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Glow
                ctx.globalAlpha = 0.1;
                const glowCol = ['#b0b0b0', '#e8c56d', '#4a90d9', '#c1440e', '#c88b3a', '#e0c77d', '#7ec8e3', '#3b5ddb'][i];
                const gg = ctx.createRadialGradient(px, py, p.size, px, py, p.size * 2.5);
                gg.addColorStop(0, glowCol);
                gg.addColorStop(1, 'transparent');
                ctx.fillStyle = gg;
                ctx.beginPath();
                ctx.arc(px, py, p.size * 2.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;

                // Labels (linear mode only)
                if (mode > 0.3) {
                    ctx.globalAlpha = Math.min(1, (mode - 0.3) * 2) * 0.3;
                    ctx.fillStyle = darkMode ? '#fff' : '#000';
                    ctx.font = `${Math.max(8, Math.min(10, W * 0.007))}px Inter, system-ui, sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.fillText(p.name, px, py + p.size + 14);
                    ctx.globalAlpha = 1;
                }
            });

            // ── Spaceship ─────────────────────────────────────
            if (mode > 0.5 && isTransferring && planetPositions.length >= 2) {
                const progress = Math.max(0, Math.min(1, transferProgress));
                const startX = planetPositions[0].linearX;
                const endX = planetPositions[planetPositions.length - 1].linearX;
                const shipX = startX + (endX - startX) * progress;
                const shipY = linearSunY - H * 0.14 - Math.sin(progress * Math.PI) * H * 0.04;

                for (let i = 0; i < 6; i++) {
                    const tx = shipX - i * 5 - Math.random() * 3;
                    const ty = shipY + (Math.random() - 0.5) * 3;
                    ctx.globalAlpha = (1 - i / 6) * 0.35;
                    ctx.fillStyle = `hsl(${25 + Math.random() * 20},100%,${55 + Math.random() * 25}%)`;
                    ctx.beginPath();
                    ctx.arc(tx, ty, 1 + Math.random() * 1.5, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;
                drawShip(ctx, shipX, shipY, Math.max(8, Math.min(12, W * 0.01)), progress);

                ctx.fillStyle = darkMode ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)';
                ctx.font = `bold ${Math.max(10, Math.min(12, W * 0.009))}px Inter, system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.round(progress * 100)}%`, shipX, shipY - 14);

                ctx.setLineDash([3, 5]);
                ctx.strokeStyle = darkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let p = 0; p <= 1; p += 0.02) {
                    const fx = startX + (endX - startX) * p;
                    const fy = linearSunY - H * 0.14 - Math.sin(p * Math.PI) * H * 0.04;
                    if (p === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
                }
                ctx.stroke();
                ctx.setLineDash([]);
            }

            animRef.current = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            cancelAnimationFrame(animRef.current);
            window.removeEventListener('resize', resize);
        };
    }, [darkMode, transferProgress, isTransferring]);

    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 pointer-events-none"
            style={{ zIndex: 0, opacity: darkMode ? 0.9 : 0.75 }}
            aria-hidden="true"
        />
    );
}
