import React, { useRef, useEffect } from 'react';

/**
 * ParallaxStarfield — Multi-layer parallax star background that responds to mouse.
 * Three layers of stars at different speeds create depth illusion.
 */
export function ParallaxStarfield({ darkMode }) {
    const canvasRef = useRef(null);
    const mouseRef = useRef({ x: 0, y: 0 });
    const animRef = useRef(null);
    const starsRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);

        // Create 3 layers of stars with different sizes/speeds
        const createStars = () => {
            const layers = [];
            const configs = [
                { count: 40, sizeRange: [0.5, 1.2], parallaxFactor: 0.015, opacity: 0.3 },
                { count: 25, sizeRange: [1.0, 2.0], parallaxFactor: 0.03, opacity: 0.5 },
                { count: 12, sizeRange: [1.5, 3.0], parallaxFactor: 0.05, opacity: 0.7 },
            ];

            for (const cfg of configs) {
                const stars = [];
                for (let i = 0; i < cfg.count; i++) {
                    stars.push({
                        x: Math.random() * canvas.width,
                        y: Math.random() * canvas.height,
                        baseX: Math.random() * canvas.width,
                        baseY: Math.random() * canvas.height,
                        size: cfg.sizeRange[0] + Math.random() * (cfg.sizeRange[1] - cfg.sizeRange[0]),
                        twinklePhase: Math.random() * Math.PI * 2,
                        twinkleSpeed: 0.01 + Math.random() * 0.03,
                    });
                }
                layers.push({ stars, ...cfg });
            }
            return layers;
        };

        starsRef.current = createStars();

        // Track mouse position (normalized to center)
        const handleMouseMove = (e) => {
            mouseRef.current = {
                x: (e.clientX - canvas.width / 2) / canvas.width,
                y: (e.clientY - canvas.height / 2) / canvas.height,
            };
        };
        window.addEventListener('mousemove', handleMouseMove);

        // Animation loop
        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const { x: mx, y: my } = mouseRef.current;

            for (const layer of starsRef.current) {
                for (const star of layer.stars) {
                    // Parallax offset based on mouse
                    const offsetX = mx * canvas.width * layer.parallaxFactor;
                    const offsetY = my * canvas.height * layer.parallaxFactor;

                    star.x = star.baseX + offsetX;
                    star.y = star.baseY + offsetY;

                    // Wrap around
                    if (star.x < 0) star.x += canvas.width;
                    if (star.x > canvas.width) star.x -= canvas.width;
                    if (star.y < 0) star.y += canvas.height;
                    if (star.y > canvas.height) star.y -= canvas.height;

                    // Twinkle
                    star.twinklePhase += star.twinkleSpeed;
                    const twinkle = 0.5 + Math.sin(star.twinklePhase) * 0.5;
                    const alpha = layer.opacity * twinkle;

                    // Draw star with glow
                    ctx.save();
                    ctx.globalAlpha = alpha;

                    // Outer glow
                    if (star.size > 1.5) {
                        const glow = ctx.createRadialGradient(
                            star.x, star.y, 0,
                            star.x, star.y, star.size * 3
                        );
                        glow.addColorStop(0, darkMode ? 'rgba(186, 200, 255, 0.4)' : 'rgba(66, 99, 235, 0.2)');
                        glow.addColorStop(1, 'transparent');
                        ctx.fillStyle = glow;
                        ctx.beginPath();
                        ctx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
                        ctx.fill();
                    }

                    // Core
                    ctx.fillStyle = darkMode ? '#dbe4ff' : '#4263eb';
                    ctx.beginPath();
                    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.restore();
                }
            }

            animRef.current = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            cancelAnimationFrame(animRef.current);
            window.removeEventListener('resize', resize);
            window.removeEventListener('mousemove', handleMouseMove);
        };
    }, [darkMode]);

    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 pointer-events-none"
            style={{ zIndex: 0, opacity: darkMode ? 0.6 : 0.25 }}
            aria-hidden="true"
        />
    );
}
