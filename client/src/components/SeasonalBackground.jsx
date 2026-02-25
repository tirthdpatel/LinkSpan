import React, { useRef, useEffect, useCallback } from 'react';

/**
 * SeasonalBackground — Canvas-based interactive particle system.
 * Auto-detects season and renders themed particles that interact with mouse.
 */

// ── Season Detection ────────────────────────────────────────
function getSeason() {
    const month = new Date().getMonth(); // 0-indexed
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'autumn';
    return 'winter';
}

// ── Season Configs ──────────────────────────────────────────
const SEASON_CONFIG = {
    winter: {
        particleCount: 80,
        colors: ['#ffffff', '#e3f2fd', '#bbdefb', '#d1ecff', '#c8e6ff'],
        speedRange: [0.3, 1.2],
        sizeRange: [2, 6],
        glowColor: 'rgba(200, 220, 255, 0.6)',
        glowSize: 8,
        drift: 0.3,       // horizontal sway
        gravity: 0.4,     // downward pull
        rotationSpeed: 0,
        shape: 'snowflake',
    },
    spring: {
        particleCount: 50,
        colors: ['#f8bbd0', '#f48fb1', '#f06292', '#ffcdd2', '#fce4ec', '#fff0f3'],
        speedRange: [0.2, 0.8],
        sizeRange: [4, 10],
        glowColor: 'rgba(244, 143, 177, 0.4)',
        glowSize: 6,
        drift: 0.6,
        gravity: 0.25,
        rotationSpeed: 0.02,
        shape: 'petal',
    },
    summer: {
        particleCount: 40,
        colors: ['#ffeb3b', '#ffd54f', '#ffe082', '#fff9c4', '#ffecb3'],
        speedRange: [0.1, 0.5],
        sizeRange: [2, 5],
        glowColor: 'rgba(255, 235, 59, 0.6)',
        glowSize: 18,
        drift: 0.8,
        gravity: 0,       // fireflies float randomly
        rotationSpeed: 0,
        shape: 'firefly',
    },
    autumn: {
        particleCount: 45,
        colors: ['#e65100', '#f57c00', '#ff9800', '#d84315', '#bf360c', '#8d6e63', '#a1887f', '#c62828'],
        speedRange: [0.3, 1.0],
        sizeRange: [6, 14],
        glowColor: 'rgba(255, 152, 0, 0.3)',
        glowSize: 4,
        drift: 0.7,
        gravity: 0.35,
        rotationSpeed: 0.03,
        shape: 'leaf',
    },
};

// ── Particle Class ──────────────────────────────────────────
class Particle {
    constructor(canvas, config) {
        this.canvas = canvas;
        this.config = config;
        this.reset(true);
    }

    reset(initial = false) {
        const { sizeRange, speedRange, colors, drift } = this.config;
        this.x = Math.random() * this.canvas.width;
        this.y = initial
            ? Math.random() * this.canvas.height
            : -20 - Math.random() * 40;
        this.size = sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0]);
        this.speedY = speedRange[0] + Math.random() * (speedRange[1] - speedRange[0]);
        this.speedX = (Math.random() - 0.5) * drift;
        this.color = colors[Math.floor(Math.random() * colors.length)];
        this.rotation = Math.random() * Math.PI * 2;
        this.rotationDir = Math.random() > 0.5 ? 1 : -1;
        this.opacity = 0.4 + Math.random() * 0.6;
        this.wobblePhase = Math.random() * Math.PI * 2;
        this.wobbleSpeed = 0.01 + Math.random() * 0.02;
        this.wobbleAmplitude = 0.3 + Math.random() * 0.7;

        // Firefly-specific
        this.pulsePhase = Math.random() * Math.PI * 2;
        this.pulseSpeed = 0.02 + Math.random() * 0.03;
        this.dirChangeTimer = 0;
        this.targetSpeedX = this.speedX;
        this.targetSpeedY = this.speedY;
    }

    update(mouseX, mouseY, mouseRadius) {
        const { gravity, rotationSpeed, shape } = this.config;

        // Wobble (sinusoidal horizontal sway)
        this.wobblePhase += this.wobbleSpeed;
        const wobble = Math.sin(this.wobblePhase) * this.wobbleAmplitude;

        if (shape === 'firefly') {
            // Fireflies float randomly, changing direction periodically
            this.dirChangeTimer++;
            if (this.dirChangeTimer > 60 + Math.random() * 120) {
                this.targetSpeedX = (Math.random() - 0.5) * 1.2;
                this.targetSpeedY = (Math.random() - 0.5) * 0.6;
                this.dirChangeTimer = 0;
            }
            this.speedX += (this.targetSpeedX - this.speedX) * 0.02;
            this.speedY += (this.targetSpeedY - this.speedY) * 0.02;
            this.x += this.speedX + wobble * 0.3;
            this.y += this.speedY;

            // Pulsing glow
            this.pulsePhase += this.pulseSpeed;
            this.opacity = 0.3 + Math.sin(this.pulsePhase) * 0.35 + 0.35;
        } else {
            // Normal gravity-based movement
            this.x += this.speedX + wobble;
            this.y += this.speedY + gravity;
            this.rotation += rotationSpeed * this.rotationDir;
        }

        // Mouse interaction — particles pushed away from cursor
        if (mouseX !== null && mouseY !== null) {
            const dx = this.x - mouseX;
            const dy = this.y - mouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < mouseRadius) {
                const force = (1 - dist / mouseRadius) * 3;
                const angle = Math.atan2(dy, dx);
                this.x += Math.cos(angle) * force;
                this.y += Math.sin(angle) * force;

                // Spin faster near mouse
                if (rotationSpeed > 0) {
                    this.rotation += rotationSpeed * 4 * this.rotationDir;
                }
            }
        }

        // Wrap around edges
        if (this.y > this.canvas.height + 30) this.reset();
        if (this.x < -30) this.x = this.canvas.width + 20;
        if (this.x > this.canvas.width + 30) this.x = -20;
        if (shape === 'firefly') {
            if (this.y < -30) this.y = this.canvas.height + 20;
        }
    }

    draw(ctx) {
        const { shape, glowColor, glowSize } = this.config;

        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rotation);

        switch (shape) {
            case 'snowflake':
                this._drawSnowflake(ctx, glowColor, glowSize);
                break;
            case 'petal':
                this._drawPetal(ctx, glowColor, glowSize);
                break;
            case 'firefly':
                this._drawFirefly(ctx, glowColor, glowSize);
                break;
            case 'leaf':
                this._drawLeaf(ctx, glowColor, glowSize);
                break;
        }

        ctx.restore();
    }

    _drawSnowflake(ctx, glowColor, glowSize) {
        // Soft glowing circle with subtle star shape
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowSize;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(0, 0, this.size, 0, Math.PI * 2);
        ctx.fill();

        // Draw tiny crystal arms
        if (this.size > 3) {
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 0.5;
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(Math.cos(angle) * this.size * 1.5, Math.sin(angle) * this.size * 1.5);
                ctx.stroke();
            }
        }
        ctx.shadowBlur = 0;
    }

    _drawPetal(ctx, glowColor, glowSize) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowSize;
        ctx.fillStyle = this.color;

        // Organic petal shape
        const s = this.size;
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.bezierCurveTo(s * 0.8, -s * 0.6, s * 0.6, s * 0.2, 0, s * 0.5);
        ctx.bezierCurveTo(-s * 0.6, s * 0.2, -s * 0.8, -s * 0.6, 0, -s);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    _drawFirefly(ctx, glowColor, glowSize) {
        // Multi-layered glow effect
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size * 4);
        gradient.addColorStop(0, this.color);
        gradient.addColorStop(0.2, this.color + 'aa');
        gradient.addColorStop(0.5, this.color + '44');
        gradient.addColorStop(1, 'transparent');

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, this.size * 4, 0, Math.PI * 2);
        ctx.fill();

        // Bright core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, this.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawLeaf(ctx, glowColor, glowSize) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowSize;
        ctx.fillStyle = this.color;

        const s = this.size;

        // Leaf shape with stem
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.bezierCurveTo(s * 0.7, -s * 0.7, s * 0.7, s * 0.3, 0, s);
        ctx.bezierCurveTo(-s * 0.7, s * 0.3, -s * 0.7, -s * 0.7, 0, -s);
        ctx.fill();

        // Center vein
        ctx.strokeStyle = this.color + '88';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.8);
        ctx.lineTo(0, s * 0.8);
        ctx.stroke();

        // Side veins
        for (let i = -2; i <= 2; i++) {
            if (i === 0) continue;
            const y = i * s * 0.25;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo((i > 0 ? 1 : -1) * s * 0.35, y - s * 0.15);
            ctx.stroke();
        }

        ctx.shadowBlur = 0;
    }
}

// ── React Component ─────────────────────────────────────────
export function SeasonalBackground({ darkMode }) {
    const canvasRef = useRef(null);
    const particlesRef = useRef([]);
    const mouseRef = useRef({ x: null, y: null });
    const animFrameRef = useRef(null);
    const seasonRef = useRef(getSeason());

    const MOUSE_RADIUS = 80;

    const handleMouseMove = useCallback((e) => {
        mouseRef.current = { x: e.clientX, y: e.clientY };
    }, []);

    const handleMouseLeave = useCallback(() => {
        mouseRef.current = { x: null, y: null };
    }, []);

    // Handle touch for mobile
    const handleTouchMove = useCallback((e) => {
        if (e.touches.length > 0) {
            mouseRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
    }, []);

    const handleTouchEnd = useCallback(() => {
        mouseRef.current = { x: null, y: null };
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const season = seasonRef.current;
        const config = SEASON_CONFIG[season];

        // Resize handler
        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);

        // Create particles
        particlesRef.current = Array.from(
            { length: config.particleCount },
            () => new Particle(canvas, config)
        );

        // Animation loop
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const { x: mx, y: my } = mouseRef.current;

            for (const p of particlesRef.current) {
                p.update(mx, my, MOUSE_RADIUS);
                p.draw(ctx);
            }

            animFrameRef.current = requestAnimationFrame(animate);
        };

        animate();

        // Events
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseleave', handleMouseLeave);
        window.addEventListener('touchmove', handleTouchMove, { passive: true });
        window.addEventListener('touchend', handleTouchEnd);

        return () => {
            cancelAnimationFrame(animFrameRef.current);
            window.removeEventListener('resize', resize);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseleave', handleMouseLeave);
            window.removeEventListener('touchmove', handleTouchMove);
            window.removeEventListener('touchend', handleTouchEnd);
        };
    }, [handleMouseMove, handleMouseLeave, handleTouchMove, handleTouchEnd]);

    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 pointer-events-none z-0"
            style={{ opacity: darkMode ? 0.7 : 0.5 }}
            aria-hidden="true"
        />
    );
}
