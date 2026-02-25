import React, { useRef, useEffect, useCallback } from 'react';
import { useGlowTrack } from '../hooks/useInteractiveEffects';

/**
 * InteractiveCard — Card with 3D tilt, glow border tracking, and elevation hover.
 * Tilt + scale is done inline here (not in a hook) to avoid ref timing issues.
 */
export function InteractiveCard({ children, className = '', onClick, id, tiltOpts = {} }) {
    const { ref: glowRef } = useGlowTrack();
    const cardRef = useRef(null);
    const glareRef = useRef(null);

    const maxTilt = tiltOpts.maxTilt || 8;
    const scale = tiltOpts.scale || 1.05;

    useEffect(() => {
        const el = cardRef.current;
        if (!el) return;

        // Share ref with glow hook
        glowRef.current = el;

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

            el.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(${scale},${scale},${scale}) translateY(-6px)`;
            el.style.transition = 'transform 0.1s ease-out';

            const gx = ((e.clientX - rect.left) / rect.width) * 100;
            const gy = ((e.clientY - rect.top) / rect.height) * 100;
            glare.style.opacity = '0.12';
            glare.style.background = `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,0.3) 0%, transparent 60%)`;
        };

        const handleMouseLeave = () => {
            el.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1) translateY(0px)';
            el.style.transition = 'transform 0.3s ease-out';
            glare.style.opacity = '0';

            // Clear inline style after transition so pure CSS :hover can work next time
            setTimeout(() => {
                if (el) el.style.transform = '';
            }, 300);
        };

        el.addEventListener('mousemove', handleMouseMove);
        el.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            el.removeEventListener('mousemove', handleMouseMove);
            el.removeEventListener('mouseleave', handleMouseLeave);
            if (glare.parentNode) glare.parentNode.removeChild(glare);
        };
    }, [maxTilt, scale]);

    return (
        <div
            ref={cardRef}
            id={id}
            className={`interactive-card ${className}`}
            style={{ position: 'relative', overflow: 'hidden' }}
            onClick={onClick}
        >
            {/* Glow border that follows mouse */}
            <div className="glow-border" />

            {/* Content */}
            <div style={{ position: 'relative', zIndex: 2 }}>
                {children}
            </div>
        </div>
    );
}

/**
 * GlowIcon — Icon container with animated glow.
 */
export function GlowIcon({ children, color, className = '' }) {
    const customStyle = color
        ? {
            background: `linear-gradient(135deg, ${color}, ${color}dd)`,
            boxShadow: `0 4px 20px ${color}33`,
        }
        : {};

    return (
        <div className={`glow-icon ${className}`} style={customStyle}>
            {children}
        </div>
    );
}
