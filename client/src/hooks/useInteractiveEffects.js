import { useRef, useCallback, useEffect } from 'react';

/**
 * useTilt — 3D perspective tilt effect on mouse movement.
 * Uses refs internally to avoid React re-renders on every mousemove.
 */
export function useTilt({ maxTilt = 8, scale = 1.02 } = {}) {
    const ref = useRef(null);
    const glareRef = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        // Create glare element
        const glare = document.createElement('div');
        glare.style.cssText = `
      position: absolute; inset: 0; border-radius: inherit;
      opacity: 0; pointer-events: none; z-index: 1;
      transition: opacity 0.15s ease;
      background: linear-gradient(135deg, rgba(255,255,255,0.25) 0%, transparent 60%);
    `;
        el.appendChild(glare);
        glareRef.current = glare;

        const handleMouseMove = (e) => {
            const rect = el.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const mouseX = e.clientX - centerX;
            const mouseY = e.clientY - centerY;

            const tiltX = -(mouseY / (rect.height / 2)) * maxTilt;
            const tiltY = (mouseX / (rect.width / 2)) * maxTilt;

            // Direct DOM manipulation — no React re-render
            el.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(${scale},${scale},${scale})`;

            const glareX = ((e.clientX - rect.left) / rect.width) * 100;
            const glareY = ((e.clientY - rect.top) / rect.height) * 100;
            glare.style.opacity = '0.12';
            glare.style.background = `radial-gradient(circle at ${glareX}% ${glareY}%, rgba(255,255,255,0.3) 0%, transparent 60%)`;
        };

        const handleMouseLeave = () => {
            el.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)';
            el.style.transition = 'transform 0.3s ease';
            glare.style.opacity = '0';
            setTimeout(() => { el.style.transition = ''; }, 300);
        };

        el.addEventListener('mousemove', handleMouseMove);
        el.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            el.removeEventListener('mousemove', handleMouseMove);
            el.removeEventListener('mouseleave', handleMouseLeave);
            if (glare.parentNode) glare.parentNode.removeChild(glare);
        };
    }, [maxTilt, scale]);

    return { ref };
}

/**
 * useMagnetic — Magnetic pull effect using direct DOM manipulation.
 */
export function useMagnetic({ strength = 0.3, threshold = 100 } = {}) {
    const ref = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const handleMouseMove = (e) => {
            const rect = el.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < threshold) {
                const pull = 1 - dist / threshold;
                el.style.transform = `translate(${dx * strength * pull}px, ${dy * strength * pull}px)`;
                el.style.transition = 'transform 0.1s ease-out';
            } else {
                el.style.transform = 'translate(0px, 0px)';
                el.style.transition = 'transform 0.3s ease';
            }
        };

        const handleMouseLeave = () => {
            el.style.transform = 'translate(0px, 0px)';
            el.style.transition = 'transform 0.3s ease';
        };

        window.addEventListener('mousemove', handleMouseMove);
        el.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            el.removeEventListener('mouseleave', handleMouseLeave);
        };
    }, [strength, threshold]);

    return { ref };
}

/**
 * useGlowTrack — Mouse-tracking glow via CSS custom properties (no re-renders).
 */
export function useGlowTrack() {
    const ref = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const handleMouseMove = (e) => {
            const rect = el.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            el.style.setProperty('--glow-x', `${x}%`);
            el.style.setProperty('--glow-y', `${y}%`);
        };

        el.addEventListener('mousemove', handleMouseMove);
        return () => el.removeEventListener('mousemove', handleMouseMove);
    }, []);

    return { ref };
}
