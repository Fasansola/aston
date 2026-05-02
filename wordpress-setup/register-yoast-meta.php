<?php
/**
 * register-yoast-meta.php
 *
 * Add this code to your WordPress theme's functions.php (or a site-specific
 * plugin). Without it, the WordPress REST API silently ignores writes to
 * Yoast meta fields (_yoast_wpseo_*) — the POST/PATCH appears to succeed
 * but the values are never stored.
 *
 * After adding this, the Aston Blog Tool will correctly write focus keywords,
 * SEO titles, meta descriptions, and Open Graph / Twitter card fields
 * when it creates or updates a post via the REST API.
 */

add_action( 'init', function () {
    $yoast_keys = [
        '_yoast_wpseo_focuskw',
        '_yoast_wpseo_title',
        '_yoast_wpseo_metadesc',
        '_yoast_wpseo_opengraph-title',
        '_yoast_wpseo_opengraph-description',
        '_yoast_wpseo_twitter-title',
        '_yoast_wpseo_twitter-description',
    ];

    foreach ( $yoast_keys as $key ) {
        register_post_meta( 'post', $key, [
            'type'          => 'string',
            'single'        => true,
            'show_in_rest'  => true,
            'auth_callback' => function () {
                return current_user_can( 'edit_posts' );
            },
        ] );
    }
} );
