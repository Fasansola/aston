<?php
/**
 * Plugin Name: Aston chart canvas guard
 * Description: Stops the WordPress editor deleting the Chart.js canvases the Aston Blog Tool writes into posts.
 *
 * Install as a must-use plugin: upload this file to wp-content/mu-plugins/
 * (create the folder if it does not exist). No activation step.
 *
 * Why: the blog tool writes each chart as
 *   <div class="aston-chart-block">…<canvas class="aston-chartjs" data-chart-…></canvas></div>
 * into the ACF body fields. When a post is opened and saved in wp-admin, the
 * ACF WYSIWYG field runs it through wpautop (which wraps the canvas in a <p>)
 * and TinyMCE 4, which deletes an EMPTY element inside a paragraph. The canvas
 * and all its data vanish and the chart renders as an empty card. Reproduced
 * with this site's own TinyMCE 4.9.11 + wp-admin/js/editor.js, Oct 2026.
 *
 * Since 2026-10-04 the tool writes text fallback content inside every canvas,
 * which TinyMCE keeps, so new posts are safe without this plugin. This plugin
 * is the belt-and-braces: it protects any canvas without fallback text, and
 * lets kses keep the canvas if a post is ever saved by a user who lacks the
 * unfiltered_html capability.
 */

// 1. TinyMCE: treat <canvas> as an element that may legitimately be empty.
//    Setting non_empty_elements REPLACES TinyMCE's default list, so the
//    defaults are repeated here.
add_filter( 'tiny_mce_before_init', function ( $init ) {
	$defaults = 'td,th,iframe,video,audio,object,script,pre,code,area,base,basefont,br,col,frame,hr,img,input,isindex,link,meta,param,embed,source,wbr,track';
	$current  = ! empty( $init['non_empty_elements'] ) ? $init['non_empty_elements'] : $defaults;
	if ( false === strpos( $current, 'canvas' ) ) {
		$init['non_empty_elements'] = $current . ',canvas';
	}
	return $init;
} );

// 2. kses: allow the chart canvas and its data-* attributes in post HTML.
add_filter( 'wp_kses_allowed_html', function ( $tags, $context ) {
	if ( 'post' === $context || 'acf' === $context ) {
		$tags['canvas'] = array(
			'class'      => true,
			'id'         => true,
			'width'      => true,
			'height'     => true,
			'role'       => true,
			'aria-label' => true,
			'data-*'     => true,
		);
	}
	return $tags;
}, 10, 2 );
